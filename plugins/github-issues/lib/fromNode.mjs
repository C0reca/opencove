// issue.create-from-node: turns one note or task node into a GitHub issue (#61), as the human.
// First line = title, the rest = body. The node keeps the link, which also makes this idempotent:
// a note gets "Issue: <url>" appended, a task gets the tag created-issue:owner/repo#N (not issue:,
// so issue.assign never mistakes it for an assigned issue).
import { cleanTerminalOutput } from './gh.mjs'
import { commandError } from './errors.mjs'
import { runGhOrThrow } from './runGh.mjs'

const GITHUB_TITLE_MAX = 256
const ISSUE_URL = /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/([1-9]\d*)/
// Only our own "Issue: <url>" line counts as the link; other issue URLs in a note do not.
const NOTE_LINK = /^Issue: (https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/([1-9]\d*))$/m
const CREATED_TAG = /^created-issue:([^/\s]+\/[^/\s#]+)#([1-9]\d*)$/

export function createFromNodeService({ host, repoOf }) {
  // ponytail: in-memory guard against a double click; a second plugin backend could still race.
  const inFlight = new Set()

  async function createFromNode({ projectId, nodeIds }) {
    if (!Array.isArray(nodeIds) || nodeIds.length !== 1) {
      throw commandError('invalid-node', 'Select exactly one note or task node.')
    }
    const nodeId = nodeIds[0]
    if (inFlight.has(nodeId)) {
      throw commandError('in-progress', 'An issue is already being created from this node.')
    }
    inFlight.add(nodeId)
    try {
      return await create(projectId, nodeId)
    } finally {
      inFlight.delete(nodeId)
    }
  }

  async function create(projectId, nodeId) {
    const node = (await host.nodes.get({ nodeId }))?.node
    const data = node?.data ?? {}
    if (node?.kind !== 'note' && node?.kind !== 'task') {
      throw commandError('invalid-node', 'Only note and task nodes can become an issue.')
    }
    const tags = Array.isArray(data.tags) ? data.tags.map(String) : []
    const text = String((node.kind === 'note' ? data.text : data.requirement) ?? '')

    const existing = node.kind === 'note' ? linkInNote(text) : linkInTags(tags)
    if (existing) {
      return { created: false, ...existing, nodeId }
    }

    const [firstLine, ...rest] = text.trim().split('\n')
    const title = (firstLine ?? '').trim()
    if (!title) {
      throw commandError('empty-text', 'The node has no text: its first line becomes the title.')
    }
    if (title.length > GITHUB_TITLE_MAX) {
      throw commandError(
        'invalid-params',
        `The first line must be at most ${GITHUB_TITLE_MAX} characters.`,
      )
    }
    const body = rest.join('\n').trim()

    const repo = await repoOf(projectId)
    // Title and body are argv elements, never shell text.
    const output = await runGhOrThrow(
      host,
      { projectId },
      ['issue', 'create', '--title', title, '--body', body],
      { repo },
    )
    const match = ISSUE_URL.exec(cleanTerminalOutput(output))
    if (!match) {
      throw commandError('gh-failed', 'gh created the issue but printed no issue URL.')
    }
    const url = match[0]
    const number = Number(match[2])

    if (node.kind === 'note') {
      await host.nodes.update({ nodeId, kind: 'note', data: { text: `${text}\n\nIssue: ${url}` } })
    } else {
      await host.nodes.update({
        nodeId,
        kind: 'task',
        data: {
          requirement: data.requirement ?? '',
          tags: [...tags, `created-issue:${match[1]}#${number}`],
          ...(data.status ? { status: data.status } : {}),
          ...(data.priority ? { priority: data.priority } : {}),
        },
      })
    }
    return { created: true, number, url, nodeId }
  }

  return { createFromNode }
}

function linkInNote(text) {
  const match = NOTE_LINK.exec(text)
  return match ? { number: Number(match[2]), url: match[1] } : null
}

function linkInTags(tags) {
  for (const tag of tags) {
    const match = CREATED_TAG.exec(tag)
    if (match) {
      return { number: Number(match[2]), url: `https://github.com/${match[1]}/issues/${match[2]}` }
    }
  }
  return null
}
