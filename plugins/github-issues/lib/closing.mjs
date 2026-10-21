// Closing and review flows for the coordinator. Every write goes through gh with argv arrays.
// Only issue.close closes an issue on evidence; close-manual is the human-only exception.
import { commandError } from './errors.mjs'
import {
  issueAddLabelArgs,
  issueCloseArgs,
  issueCommentArgs,
  labelCreateArgs,
  NEEDS_REVIEW_LABEL,
  parsePrView,
  prViewArgs,
} from './gh.mjs'
import { requirePositiveInt, requireProjectId, optionalText, requireText } from './params.mjs'
import { runGh, runGhOrThrow } from './runGh.mjs'
import { listTaskNodes, setTaskStatus } from './tasks.mjs'
import { taskTag } from './requirement.mjs'

export function createClosingService({ host, repoOf }) {
  async function viewPull(projectId, pr) {
    const result = await runGh(host, { projectId }, prViewArgs(pr))
    if (!result.ok) {
      const missing = /could not resolve|not found|no pull request/i.test(result.error.message)
      throw commandError(
        missing ? 'pr-not-found' : result.error.code,
        missing ? `PR #${pr} was not found in this repository.` : result.error.message,
        { pr },
      )
    }
    try {
      return parsePrView(result.output)
    } catch (caught) {
      throw commandError('gh-failed', caught instanceof Error ? caught.message : String(caught))
    }
  }

  // Marks the task for issue `repo#number` as done when it exists; returns its node id or null.
  async function markTaskDone(projectId, repo, number) {
    const tag = taskTag(repo, number)
    const task = (await listTaskNodes(host, projectId)).find(item =>
      (Array.isArray(item.data.tags) ? item.data.tags : []).some(
        value => String(value).toLowerCase() === tag,
      ),
    )
    if (!task) {
      return null
    }
    await setTaskStatus(host, task, 'done')
    return task.id
  }

  async function closeWithComment({ projectId, repo, number, comment }) {
    const target = { projectId }
    await runGhOrThrow(host, target, issueCommentArgs(number, comment))
    await runGhOrThrow(host, target, issueCloseArgs(number))
    return markTaskDone(projectId, repo, number)
  }

  // Closes only when the PR is MERGED and declares it closes this issue. Nothing else closes.
  async function close({ projectId, number, pr, evidence }) {
    const project = requireProjectId(projectId)
    const issueNumber = requirePositiveInt(number, 'number')
    const prNumber = requirePositiveInt(pr, 'pr')
    const note = optionalText(evidence, 'evidence')
    const repo = await repoOf(project)
    const pull = await viewPull(project, prNumber)

    if (pull.state !== 'MERGED') {
      throw commandError(
        'pr-not-merged',
        `PR #${prNumber} is ${pull.state || 'not readable'}, not MERGED. Issue #${issueNumber} stays open; use issue.request-review.`,
        { pr: prNumber, state: pull.state },
      )
    }
    // Decision: a merged PR that does not declare it closes the issue is refused, because the
    // evidence would then be about a different change.
    if (!pull.closes.includes(issueNumber)) {
      throw commandError(
        'pr-not-linked',
        `PR #${prNumber} does not close issue #${issueNumber} (no "Fixes #${issueNumber}" in its description).`,
        { pr: prNumber, number: issueNumber },
      )
    }

    const comment = [
      `Closed: merged pull request ${pull.url || `#${prNumber}`} resolves this issue.`,
      note ? `Evidence: ${note}` : null,
    ]
      .filter(Boolean)
      .join('\n\n')
    const taskNodeId = await closeWithComment({
      projectId: project,
      repo,
      number: issueNumber,
      comment,
    })
    return { repo, number: issueNumber, pr: prNumber, prUrl: pull.url, taskNodeId, closed: true }
  }

  // Adds needs-review and a comment; never closes. The label is created idempotently.
  async function requestReview({ projectId, number, summary, evidence }) {
    const project = requireProjectId(projectId)
    const issueNumber = requirePositiveInt(number, 'number')
    const text = requireText(summary, 'summary')
    const proof = requireText(evidence, 'evidence')
    const repo = await repoOf(project)
    const target = { projectId: project }

    await runGhOrThrow(
      host,
      target,
      labelCreateArgs(NEEDS_REVIEW_LABEL, 'Needs a human decision before this issue is closed'),
    )
    await runGhOrThrow(host, target, issueAddLabelArgs(issueNumber, NEEDS_REVIEW_LABEL))
    await runGhOrThrow(
      host,
      target,
      issueCommentArgs(issueNumber, `Review requested.\n\nSummary: ${text}\n\nEvidence: ${proof}`),
    )
    return { repo, number: issueNumber, label: NEEDS_REVIEW_LABEL, closed: false }
  }

  // Human-only (the caller checks the host context): closes without a PR, with the reason recorded.
  async function closeManual({ projectId, number, reason }) {
    const project = requireProjectId(projectId)
    const issueNumber = requirePositiveInt(number, 'number')
    const why = requireText(reason, 'reason', 1000)
    const repo = await repoOf(project)
    const comment = `Closed by a human without a pull request. Reason: ${why}`
    const taskNodeId = await closeWithComment({
      projectId: project,
      repo,
      number: issueNumber,
      comment,
    })
    return { repo, number: issueNumber, pr: null, taskNodeId, closed: true }
  }

  return { close, requestReview, closeManual }
}
