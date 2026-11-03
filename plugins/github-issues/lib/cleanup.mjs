// Cleanup after merge (#58): when the pull request of an issue task is MERGED, close the issue (if
// still open), mark the task done, archive its worktree and local branch, delete the remote branch
// and archive the issue Space. A bounded backend timer, stopped in dispose().
//
// Invariants: nothing is deleted without a MERGED pull request read in the same pass; every step is
// idempotent, so a pass that fails half-way is finished by a later one; only the issue's own Space,
// worktree and branch (`issue-<N>[-slug]`, the name issue.assign gave them) are touched.
import { extractJson, issueCloseArgs, issueCommentArgs } from './gh.mjs'
import { runGhOrThrow } from './runGh.mjs'
import { mapSeries } from './sequence.mjs'
import { issueTagOf, listTaskNodes, parseIssueTag, setTaskStatus } from './tasks.mjs'
import { isWorktreeDirectory, listProjectSpaces, runOpencove } from './worktree.mjs'

export const CLEANUP_PREFERENCE = 'auto-cleanup'
// ponytail: one `gh pr list` per open issue task every 2 minutes; batch by repo if that gets slow.
export const CLEANUP_TICK_MS = 120_000
// 'done' is included because the task node only disappears with its Space (the last step), so a
// done task that still exists means an earlier pass stopped before the end.
const CANDIDATE_STATUSES = new Set(['doing', 'ai_done', 'done'])
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop', 'trunk'])

// issue.assign names the Space and the branch `issue-<N>` or `issue-<N>-<slug>` (worktree.mjs).
export function isOwnBranch(branch, number) {
  return (
    !PROTECTED_BRANCHES.has(branch) && new RegExp(`^issue-${number}(-[a-z0-9-]+)?$`).test(branch)
  )
}

export function mergedPullArgs(branch) {
  return [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'merged',
    '--json',
    'number,state,headRefName,baseRefName,closingIssuesReferences,url',
    '--limit',
    '10',
  ]
}

// The merged PR from `branch` that declares it closes issue `number`, or null.
export function findMergedPull(text, { branch, number }) {
  const list = extractJson(text)
  return (
    (Array.isArray(list) ? list : []).find(
      pull =>
        String(pull?.state).toUpperCase() === 'MERGED' &&
        pull.headRefName === branch &&
        pull.baseRefName !== branch &&
        (pull.closingIssuesReferences ?? []).some(reference => reference?.number === number),
    ) ?? null
  )
}

export function createCleanupService({
  host,
  projectIds,
  repoOf,
  log = () => undefined,
  tickMs = CLEANUP_TICK_MS,
}) {
  let timer = null
  let disposed = false
  let inFlight = null

  function tick() {
    if (disposed) {
      return Promise.resolve()
    }
    if (!inFlight) {
      inFlight = runPass()
        .catch(caught => log(`cleanup pass failed: ${messageOf(caught)}`))
        .finally(() => {
          inFlight = null
        })
    }
    return inFlight
  }

  function start() {
    if (timer || disposed) {
      return
    }
    timer = setInterval(() => {
      tick()
    }, tickMs)
    timer.unref?.()
  }

  async function dispose() {
    disposed = true
    clearInterval(timer)
    timer = null
    await inFlight
  }

  async function runPass() {
    const preferences = (await host.preferences.get()) ?? {}
    if (preferences[CLEANUP_PREFERENCE] === false) {
      return
    }
    await mapSeries(await projectIds(), async projectId => {
      if (!disposed) {
        await cleanProject(projectId).catch(caught =>
          log(`cleanup: project ${projectId} skipped: ${messageOf(caught)}`),
        )
      }
    })
  }

  async function cleanProject(projectId) {
    const tasks = (await listTaskNodes(host, projectId)).filter(
      task =>
        task.spaceId && CANDIDATE_STATUSES.has(task.data.status) && issueTagOf(task.data.tags),
    )
    if (tasks.length === 0) {
      return
    }
    const repo = await repoOf(projectId)
    const spaces = await listProjectSpaces(host, projectId)
    await mapSeries(tasks, task =>
      cleanIssue({ projectId, repo, spaces, task }).catch(caught =>
        log(`cleanup: ${repo} task ${task.id} stopped: ${messageOf(caught)}`),
      ),
    )
  }

  async function cleanIssue({ projectId, repo, spaces, task }) {
    const { repo: taggedRepo, number } = parseIssueTag(issueTagOf(task.data.tags))
    const space = spaces.find(candidate => candidate.id === task.spaceId)
    if (taggedRepo !== repo.toLowerCase() || !space || !isOwnBranch(space.name, number)) {
      return
    }
    const branch = space.name
    const target = { projectId }

    const listed = await runGhOrThrow(host, target, mergedPullArgs(branch), { repo })
    const pull = findMergedPull(listed, { branch, number })
    if (!pull) {
      return
    }

    await closeIssueIfOpen({ target, repo, number, pull })
    if (task.data.status !== 'done') {
      await setTaskStatus(host, task, 'done')
    }
    if (isWorktreeDirectory(space.directoryPath)) {
      // No --force: a worktree with uncommitted changes stops here and is kept.
      await mustRun(projectId, ['worktree', 'archive', '--space', space.id, '--delete-branch'])
    }
    await deleteRemoteBranch({ target, repo, branch })
    await mustRun(projectId, ['space', 'archive', '--space', space.id, '--project', projectId])
    log(`cleanup: ${repo}#${number} cleaned after merged PR #${pull.number}`)
  }

  async function closeIssueIfOpen({ target, repo, number, pull }) {
    const viewed = await runGhOrThrow(
      host,
      target,
      ['issue', 'view', String(number), '--json', 'state'],
      {
        repo,
      },
    )
    if (String(extractJson(viewed)?.state).toUpperCase() !== 'OPEN') {
      return
    }
    const comment = `Closed: merged pull request ${pull.url || `#${pull.number}`} resolves this issue (automatic cleanup).`
    await runGhOrThrow(host, target, issueCommentArgs(number, comment), { repo })
    await runGhOrThrow(host, target, issueCloseArgs(number), { repo })
  }

  // Reads the branch first (matching-refs answers 200 with [] when it is gone), so a branch deleted
  // by GitHub or by an earlier pass is not an error. gh classifies a 404 as "gh missing".
  async function deleteRemoteBranch({ target, repo, branch }) {
    const ref = `refs/heads/${branch}`
    const matching = await runGhOrThrow(host, target, [
      'api',
      `repos/${repo}/git/matching-refs/heads/${branch}`,
    ])
    const refs = extractJson(matching)
    if (!(Array.isArray(refs) ? refs : []).some(item => item?.ref === ref)) {
      return
    }
    await runGhOrThrow(host, target, ['api', '-X', 'DELETE', `repos/${repo}/git/${ref}`])
  }

  async function mustRun(projectId, args) {
    const result = await runOpencove(host, projectId, args)
    if (!result.ok) {
      throw new Error(`opencove ${args.slice(0, 2).join(' ')}: ${result.error.message}`)
    }
  }

  return { start, tick, dispose }
}

function messageOf(caught) {
  return caught instanceof Error ? caught.message : String(caught)
}
