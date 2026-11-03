import { describe, expect, it } from 'vitest'
import {
  createCleanupService,
  findMergedPull,
  isOwnBranch,
} from '../../../plugins/github-issues/lib/cleanup.mjs'
import { createFakeHost, failed, ok, type FakeNode, type GhReply } from './githubIssuesFakeHost'

const REPO = 'C0reca/opencove'
const BRANCH = 'issue-7-fix-login'
const WORKTREE_DIR = `/repo/.opencove/worktrees/${BRANCH}--abc`

const task = (status: string, extra: Partial<FakeNode> = {}): FakeNode => ({
  id: 'task-7',
  kind: 'task',
  title: '#7',
  spaceId: 'space-7',
  data: { kind: 'task', tags: [`issue:${REPO}#7`], status, requirement: 'r' },
  ...extra,
})

const pull = (extra: Record<string, unknown> = {}) => ({
  number: 70,
  state: 'MERGED',
  headRefName: BRANCH,
  baseRefName: 'main',
  closingIssuesReferences: [{ number: 7 }],
  url: 'https://github.com/C0reca/opencove/pull/70',
  ...extra,
})

function harness(
  options: {
    status?: string
    spaceName?: string
    directoryPath?: string
    pulls?: unknown[]
    issueState?: string
    remoteRefs?: unknown[]
    worktreeArchive?: GhReply
    prefs?: Record<string, unknown>
  } = {},
) {
  const spaces = [
    { id: 'space-root', name: 'Main', parentSpaceId: null, directoryPath: '/repo' },
    {
      id: 'space-7',
      name: options.spaceName ?? BRANCH,
      parentSpaceId: 'space-root',
      directoryPath: options.directoryPath ?? WORKTREE_DIR,
    },
  ]
  const route = (args: string[], command = 'gh'): GhReply => {
    const line = args.join(' ')
    if (command === 'opencove') {
      if (line.startsWith('space list')) {
        return ok(JSON.stringify({ ok: true, value: { spaces } }))
      }
      if (line.startsWith('worktree archive')) {
        return options.worktreeArchive ?? ok('{"ok":true}')
      }
      return ok('{"ok":true}')
    }
    if (line.startsWith('pr list')) {
      return ok(JSON.stringify(options.pulls ?? [pull()]))
    }
    if (line.startsWith('issue view')) {
      return ok(JSON.stringify({ state: options.issueState ?? 'OPEN' }))
    }
    if (line.startsWith(`api repos/${REPO}/git/matching-refs`)) {
      return ok(JSON.stringify(options.remoteRefs ?? [{ ref: `refs/heads/${BRANCH}` }]))
    }
    if (line.startsWith('issue ') || line.startsWith('api -X DELETE')) {
      return ok('')
    }
    return failed(`unexpected call: ${line}`)
  }
  const fake = createFakeHost({
    gh: route,
    nodes: [task(options.status ?? 'ai_done')],
    prefs: (options.prefs ?? {}) as never,
  })
  const logs: string[] = []
  const service = createCleanupService({
    host: fake.host as never,
    projectIds: async () => ['p1'],
    repoOf: async () => REPO,
    log: (line: string) => logs.push(line),
  })
  const opencove = () => fake.processCalls.map(call => call.args.slice(0, 2).join(' '))
  const writes = () =>
    fake.ghCalls
      .map(args => args.join(' '))
      .filter(line => /^issue (comment|close)|^api -X DELETE/.test(line))
  return { fake, service, logs, opencove, writes }
}

describe('github-issues cleanup rules', () => {
  it('only treats the issue branch name issue.assign gives as its own', () => {
    expect(isOwnBranch('issue-7', 7)).toBe(true)
    expect(isOwnBranch('issue-7-fix-login', 7)).toBe(true)
    expect(isOwnBranch('issue-71', 7)).toBe(false)
    expect(isOwnBranch('issue-8-fix', 7)).toBe(false)
    expect(isOwnBranch('main', 7)).toBe(false)
  })

  it('needs a MERGED PR from the branch that declares it closes the issue', () => {
    const at = { branch: BRANCH, number: 7 }
    expect(findMergedPull(JSON.stringify([pull()]), at)?.number).toBe(70)
    expect(findMergedPull(JSON.stringify([pull({ state: 'OPEN' })]), at)).toBeNull()
    expect(findMergedPull(JSON.stringify([pull({ closingIssuesReferences: [] })]), at)).toBeNull()
    expect(findMergedPull(JSON.stringify([pull({ headRefName: 'other' })]), at)).toBeNull()
    expect(findMergedPull(JSON.stringify([pull({ baseRefName: BRANCH })]), at)).toBeNull()
  })
})

describe('github-issues cleanup after merge', () => {
  it('closes the issue, marks the task done, then archives worktree, remote branch and Space', async () => {
    const h = harness()
    await h.service.tick()
    expect(h.writes()).toEqual([
      expect.stringMatching(/^issue comment 7 --body Closed: merged pull request .*pull\/70/),
      'issue close 7',
      `api -X DELETE repos/${REPO}/git/refs/heads/${BRANCH}`,
    ])
    expect((await h.fake.host.nodes.get({ nodeId: 'task-7' })).node?.data.status).toBe('done')
    expect(h.opencove()).toEqual(['space list', 'worktree archive', 'space archive'])
    expect(h.fake.processCalls[1].args).toEqual([
      'worktree',
      'archive',
      '--space',
      'space-7',
      '--delete-branch',
    ])
    expect(h.fake.processCalls[2].args).toEqual([
      'space',
      'archive',
      '--space',
      'space-7',
      '--project',
      'p1',
    ])
  })

  it('touches nothing while the PR is not merged', async () => {
    const h = harness({ pulls: [] })
    await h.service.tick()
    expect(h.writes()).toEqual([])
    expect(h.opencove()).toEqual(['space list'])
    expect((await h.fake.host.nodes.get({ nodeId: 'task-7' })).node?.data.status).toBe('ai_done')
  })

  it('touches nothing when the merged PR does not close this issue', async () => {
    const h = harness({ pulls: [pull({ closingIssuesReferences: [{ number: 8 }] })] })
    await h.service.tick()
    expect(h.writes()).toEqual([])
    expect(h.opencove()).toEqual(['space list'])
  })

  it('never looks at a Space that is not named for the issue', async () => {
    const h = harness({ spaceName: 'main' })
    await h.service.tick()
    expect(h.fake.ghCalls.some(args => args[0] === 'pr')).toBe(false)
    expect(h.opencove()).toEqual(['space list'])
  })

  it('finishes an interrupted cleanup without repeating the done steps', async () => {
    const h = harness({
      status: 'done',
      issueState: 'CLOSED',
      directoryPath: '/repo',
      remoteRefs: [],
    })
    await h.service.tick()
    expect(h.writes()).toEqual([])
    expect(h.opencove()).toEqual(['space list', 'space archive'])
  })

  it('keeps the remote branch and the Space when the worktree archive fails', async () => {
    const h = harness({ worktreeArchive: failed('worktree has uncommitted changes') })
    await h.service.tick()
    expect(h.writes()).toEqual([expect.stringMatching(/^issue comment 7/), 'issue close 7'])
    expect(h.opencove()).toEqual(['space list', 'worktree archive'])
    expect(h.logs.join('\n')).toMatch(/stopped: opencove worktree archive/)
  })

  it('does nothing while the auto-cleanup preference is false', async () => {
    const h = harness({ prefs: { 'auto-cleanup': false } })
    await h.service.tick()
    expect(h.fake.ghCalls).toEqual([])
    expect(h.opencove()).toEqual([])
  })
})
