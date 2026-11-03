// Review queue ("Para rever", #56): open PRs whose source issue has needs-review, and the three
// human decisions on them. Reached only through the view's api.invoke, never through runCommand,
// so no agent (CLI `plugin run`) can merge or close a pull request. GitHub is the durable truth;
// the queue is derived on every read.
import { writeAgentGuard } from './agentSettings.mjs'
import { createTtlCache } from './cache.mjs'
import { commandError } from './errors.mjs'
import { extractJson, NEEDS_REVIEW_LABEL, parsePrView, prViewArgs } from './gh.mjs'
import { effectiveModeFor } from './locality.mjs'
import { requirePositiveInt, requireProjectId, requireText } from './params.mjs'
import { corePermissionMode, permissionModeFor } from './permissions.mjs'
import { taskTag } from './requirement.mjs'
import { runGhOrThrow } from './runGh.mjs'
import { findSeries, mapSeries } from './sequence.mjs'
import { readTrustPolicy } from './trust.mjs'
import { targetWorkingDirectory } from './worktree.mjs'

export const QUEUE_TTL_MS = 30_000
export const PR_LIST_LIMIT = 50
const PR_FIELDS =
  'number,title,url,author,createdAt,closingIssuesReferences,statusCheckRollup,files'
// The comment issue.request-review writes (closing.mjs).
const REVIEW_COMMENT = /^Review requested\.\s*\n\s*\nSummary: ([\s\S]*?)\n\s*\nEvidence: ([\s\S]*)$/
const FAILED = new Set([
  'FAILURE',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'ERROR',
])
const SUBMIT_DELAY_MS = 1_500
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// statusCheckRollup -> 'failing' | 'pending' | 'passing' | 'none'.
export function ciState(rollup) {
  const checks = Array.isArray(rollup) ? rollup : []
  if (checks.length === 0) {
    return 'none'
  }
  const results = checks.map(check => String(check?.conclusion || check?.state || '').toUpperCase())
  if (results.some(result => FAILED.has(result))) {
    return 'failing'
  }
  const pending = checks.some(
    (check, index) =>
      (check?.status && String(check.status).toUpperCase() !== 'COMPLETED') ||
      ['', 'PENDING', 'EXPECTED'].includes(results[index]),
  )
  return pending ? 'pending' : 'passing'
}

// The agent's summary and evidence from the newest issue.request-review comment, or nulls.
export function reviewNote(comments) {
  for (const comment of [...(Array.isArray(comments) ? comments : [])].reverse()) {
    const match = REVIEW_COMMENT.exec(String(comment?.body ?? '').replace(/\r/g, ''))
    if (match) {
      return { summary: match[1].trim(), evidence: match[2].trim() }
    }
  }
  return { summary: null, evidence: null }
}

export function createReviewService({
  host,
  issues,
  closing,
  repoOf,
  sleep = delay,
  submitDelayMs = SUBMIT_DELAY_MS,
}) {
  const cache = createTtlCache({ ttlMs: QUEUE_TTL_MS })
  // Merges in progress, by repo#pr: a second click while the first runs is refused.
  const merging = new Set()

  async function list({ refresh = false } = {}) {
    const report = await issues.listAllProjects({ refresh })
    const errors = [...(report.errors ?? [])]
    const items = []
    await mapSeries(report.repos ?? [], async entry => {
      const waiting = entry.issues.filter(issue => issue.labels.includes(NEEDS_REVIEW_LABEL))
      if (waiting.length === 0) {
        return
      }
      try {
        const cached = refresh ? undefined : cache.get(entry.repo)
        const repoItems = cached ?? (await readRepo(entry.repo, entry.projectIds[0], waiting))
        cache.set(entry.repo, repoItems)
        items.push(...repoItems)
      } catch (caught) {
        errors.push({
          repo: entry.repo,
          code: caught?.code ?? 'gh-failed',
          message: messageOf(caught),
        })
      }
    })
    return { items, errors }
  }

  async function readRepo(repo, projectId, waiting) {
    const target = { projectId }
    const pulls = extractJson(
      await runGhOrThrow(
        host,
        target,
        ['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', PR_FIELDS],
        { repo },
      ),
    )
    const byNumber = new Map(waiting.map(issue => [issue.number, issue]))
    const matched = (Array.isArray(pulls) ? pulls : [])
      .map(pull => {
        const closes = (pull.closingIssuesReferences ?? []).map(ref => ref?.number)
        const issue = closes.map(number => byNumber.get(number)).find(Boolean)
        return issue ? { pull, issue } : null
      })
      .filter(Boolean)
    return mapSeries(matched, async ({ pull, issue }) => {
      const view = extractJson(
        await runGhOrThrow(
          host,
          target,
          ['issue', 'view', String(issue.number), '--json', 'comments'],
          {
            repo,
          },
        ),
      )
      return {
        repo,
        projectId,
        issue: { number: issue.number, title: issue.title, url: issue.url },
        pr: {
          number: pull.number,
          title: String(pull.title ?? ''),
          url: String(pull.url ?? ''),
          author: pull.author?.login ?? null,
          createdAt: pull.createdAt ?? null,
          files: (pull.files ?? []).map(file => String(file?.path ?? '')).filter(Boolean),
          ci: ciState(pull.statusCheckRollup),
        },
        ...reviewNote(view?.comments),
      }
    })
  }

  async function decisionTarget(params) {
    const projectId = requireProjectId(params?.projectId)
    const number = requirePositiveInt(params?.number, 'number')
    const pr = requirePositiveInt(params?.pr, 'pr')
    return { projectId, number, pr, repo: await repoOf(projectId) }
  }

  // Squash merge after reading the PR again; the issue then closes through issue.close.
  async function merge(params) {
    const { projectId, number, pr, repo } = await decisionTarget(params)
    const key = `${repo}#${pr}`
    if (merging.has(key)) {
      throw commandError('merge-in-progress', `PR #${pr} is already being merged.`)
    }
    merging.add(key)
    try {
      const target = { projectId }
      const pull = parsePrView(await runGhOrThrow(host, target, prViewArgs(pr), { repo }))
      if (!pull.closes.includes(number)) {
        throw commandError('pr-not-linked', `PR #${pr} does not declare "Fixes #${number}".`)
      }
      // Already MERGED (a repeated click after success): skip straight to closing the issue.
      if (pull.state === 'OPEN') {
        await runGhOrThrow(host, target, ['pr', 'merge', String(pr), '--squash'], { repo })
      } else if (pull.state !== 'MERGED') {
        throw commandError(
          'pr-not-open',
          `PR #${pr} is ${pull.state || 'not readable'}; nothing was merged.`,
        )
      }
      cache.delete(repo)
      return await closing.close({
        projectId,
        number,
        pr,
        evidence: 'Squash-merged from the review queue.',
      })
    } finally {
      merging.delete(key)
    }
  }

  // Comments on the PR, removes needs-review and hands the work back to the issue's engineer agent
  // in its existing Space and worktree. Never creates a worktree.
  async function requestChanges(params) {
    const { projectId, number, pr, repo } = await decisionTarget(params)
    const body = requireText(params?.body, 'body')
    const target = { projectId }
    await runGhOrThrow(
      host,
      target,
      ['pr', 'comment', String(pr), '--body', `Changes requested in the review queue:\n\n${body}`],
      { repo },
    )
    await runGhOrThrow(
      host,
      target,
      ['issue', 'edit', String(number), '--remove-label', NEEDS_REVIEW_LABEL],
      {
        repo,
      },
    )
    cache.delete(repo)
    return { repo, number, pr, ...(await returnToEngineer({ projectId, repo, number, pr, body })) }
  }

  async function returnToEngineer({ projectId, repo, number, pr, body }) {
    const task = await findTask(projectId, taskTag(repo, number))
    if (!task?.spaceId) {
      return { returnedTo: null, reason: 'no-task' }
    }
    const message = `Changes were requested on PR #${pr} for issue #${number}: ${body}`
    const agentNodeId = task.data.linkedAgentNodeId ?? null
    const agent = agentNodeId
      ? await host.agents.get({ nodeId: agentNodeId }).catch(() => null)
      : null
    if (agent?.session?.status === 'running') {
      // Two writes (text, then Enter) because of Claude Code's paste protection; one line.
      await host.agents.write({
        nodeId: agentNodeId,
        data: `[github-issues] ${message.replace(/\s+/g, ' ')} Fix them in this worktree and push to the same branch.`,
      })
      await sleep(submitDelayMs)
      await host.agents.write({ nodeId: agentNodeId, data: '\r' })
      return { returnedTo: 'running-agent', agentNodeId }
    }
    // The old agent node blocks a new task link (core refuses a second linked agent), so close it.
    if (agent?.node) {
      await host.nodes.close({ nodeId: agentNodeId })
    }
    const launchTarget = { projectId, spaceId: task.spaceId }
    await writeAgentGuard({
      host,
      projectId,
      spaceId: task.spaceId,
      root: await targetWorkingDirectory(host, launchTarget),
    })
    const policy = readTrustPolicy((await host.preferences.get()) ?? {})
    const decision = await effectiveModeFor(
      host,
      launchTarget,
      permissionModeFor(policy.permissionModes, repo),
    )
    const launched = await host.agents.launch({
      target: launchTarget,
      title: task.title,
      prompt: `${task.data.requirement ?? ''}\n\n${message}\nFix them in this worktree and push to the same branch.`,
      provider: 'claude-code',
      agentPermissionMode: corePermissionMode(decision.effectiveMode),
      taskNodeId: task.id,
    })
    return {
      returnedTo: 'relaunched',
      agentNodeId: launched?.node?.id ?? null,
      spaceId: task.spaceId,
    }
  }

  async function closeWithoutMerge(params) {
    const { projectId, number, pr, repo } = await decisionTarget(params)
    const body = requireText(params?.body, 'body')
    const target = { projectId }
    await runGhOrThrow(host, target, ['pr', 'close', String(pr), '--comment', body], { repo })
    await runGhOrThrow(
      host,
      target,
      ['issue', 'edit', String(number), '--remove-label', NEEDS_REVIEW_LABEL],
      {
        repo,
      },
    )
    cache.delete(repo)
    return { repo, number, pr, closed: true }
  }

  async function findTask(projectId, tag) {
    const listed = await host.nodes.list({ projectId, kind: 'task' })
    return findSeries(listed.nodes ?? [], async node => {
      const data = (await host.nodes.get({ nodeId: node.id }))?.node?.data ?? {}
      const tags = Array.isArray(data.tags) ? data.tags : []
      return tags.some(value => String(value).toLowerCase() === tag)
        ? { id: node.id, title: node.title, data, spaceId: node.spaceId ?? null }
        : null
    })
  }

  return { list, merge, requestChanges, closeWithoutMerge }
}

function messageOf(caught) {
  return caught instanceof Error ? caught.message : String(caught)
}
