// Task node lookups for the coordinator. Reads are sequential (host admission limits).
// assign.mjs keeps its own lookup; this module serves status and close.
import { commandError } from './errors.mjs'
import { mapSeries } from './sequence.mjs'

const ISSUE_TAG = /^issue:([^/\s]+\/[^/\s#]+)#([1-9]\d*)$/

// "issue:owner/repo#N" -> { repo, number }, or null for any other tag.
export function parseIssueTag(tag) {
  const match = ISSUE_TAG.exec(String(tag ?? ''))
  return match ? { repo: match[1].toLowerCase(), number: Number(match[2]) } : null
}

export function issueTagOf(tags) {
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (parseIssueTag(tag)) {
      return String(tag)
    }
  }
  return null
}

// Every task node of a project with its data. Fails rather than miss tasks past the list cap.
export async function listTaskNodes(host, projectId) {
  const listed = await host.nodes.list({ projectId, kind: 'task' })
  if (listed.truncated) {
    throw commandError('too-many-tasks', 'The project has too many task nodes to read safely.')
  }
  return mapSeries(listed.nodes ?? [], async node => {
    const detail = await host.nodes.get({ nodeId: node.id })
    return { id: node.id, title: node.title, data: detail?.node?.data ?? {} }
  })
}

// Writes status on an existing task, passing its other fields back so none are dropped.
export function setTaskStatus(host, task, status) {
  return host.nodes.update({
    nodeId: task.id,
    kind: 'task',
    data: {
      requirement: task.data.requirement ?? '',
      status,
      tags: Array.isArray(task.data.tags) ? task.data.tags : [],
      ...(task.data.priority ? { priority: task.data.priority } : {}),
    },
  })
}
