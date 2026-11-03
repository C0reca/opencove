import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { activate } from '../../../plugins/github-issues/main.mjs'
import { ciState, reviewNote } from '../../../plugins/github-issues/lib/review.mjs'
import {
  createFakeHost,
  failed,
  ok,
  remotes,
  type FakeNode,
  type GhReply,
} from './githubIssuesFakeHost'

const REPO = 'C0reca/opencove'
const PR_URL = 'https://github.com/C0reca/opencove/pull/12'
const VIEW = {
  pluginId: 'github-issues',
  nodeId: 'view-1',
  workspaceId: null,
  directoryPath: null,
  preview: false,
}

const ISSUES = [
  {
    number: 5,
    title: 'Login bug',
    url: 'u5',
    labels: [{ name: 'needs-review' }],
    author: { login: 'C0reca' },
  },
  { number: 6, title: 'Other', url: 'u6', labels: [], author: { login: 'C0reca' } },
]
const PULLS = [
  {
    number: 12,
    title: 'Fix login',
    url: PR_URL,
    author: { login: 'bot' },
    createdAt: '2026-11-01T10:00:00Z',
    closingIssuesReferences: [{ number: 5 }],
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    files: [{ path: 'src/login.ts' }],
  },
  // Closes an issue without needs-review: not in the queue.
  { number: 13, title: 'Other', url: 'u13', closingIssuesReferences: [{ number: 6 }], files: [] },
]
const COMMENTS = {
  comments: [
    { body: 'Review requested.\n\nSummary: Fixed the redirect.\n\nEvidence: 12 tests pass' },
  ],
}

function ghFor(prState: { state: string } = { state: 'OPEN' }) {
  return (args: string[]): GhReply => {
    const line = args.join(' ')
    if (line === 'remote -v') {
      return ok(remotes(REPO))
    }
    if (line.startsWith('issue list ')) {
      return ok(JSON.stringify(ISSUES))
    }
    if (line.startsWith('pr list ')) {
      return ok(JSON.stringify(PULLS))
    }
    if (line === 'issue view 5 --json comments') {
      return ok(JSON.stringify(COMMENTS))
    }
    if (line.startsWith('pr view 12 ')) {
      return ok(
        JSON.stringify({ ...prState, url: PR_URL, closingIssuesReferences: [{ number: 5 }] }),
      )
    }
    if (line === 'pr merge 12 --squash') {
      prState.state = 'MERGED'
      return ok('')
    }
    if (/^(issue (comment|close|edit)|pr (comment|close)) /.test(line)) {
      return ok('')
    }
    return failed(`unexpected gh call: ${line}`)
  }
}

const task = (agentId: string | null): FakeNode => ({
  id: 'task-5',
  kind: 'task',
  title: '#5 Login bug',
  spaceId: 'space-5',
  data: {
    kind: 'task',
    requirement: 'Work on it',
    tags: ['issue:c0reca/opencove#5'],
    status: 'doing',
    linkedAgentNodeId: agentId,
  },
})
const agent: FakeNode = {
  id: 'agent-5',
  kind: 'agent',
  title: '#5',
  spaceId: 'space-5',
  data: { kind: 'agent' },
}

async function plugin(
  options: {
    gh?: (args: string[]) => GhReply
    nodes?: FakeNode[]
    sessions?: Record<string, string>
  } = {},
) {
  const fake = createFakeHost({
    gh: options.gh ?? ghFor(),
    nodes: options.nodes ?? [],
    sessions: options.sessions,
  })
  const backend = await activate({ host: fake.host, log: () => undefined })
  const invoke = (method: string, params: Record<string, unknown> = {}, context: unknown = VIEW) =>
    backend.invoke(method, params, context)
  return { fake, backend, invoke }
}

const ghLines = (calls: string[][]) => calls.map(args => args.join(' '))

describe('github-issues review queue helpers', () => {
  it('summarises the CI rollup', () => {
    expect(ciState([])).toBe('none')
    expect(ciState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }])).toBe(
      'passing',
    )
    expect(ciState([{ status: 'IN_PROGRESS', conclusion: '' }])).toBe('pending')
    expect(ciState([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'QUEUED' }])).toBe(
      'failing',
    )
  })

  it('reads the newest request-review comment', () => {
    expect(reviewNote([{ body: 'hello' }])).toEqual({ summary: null, evidence: null })
    expect(
      reviewNote([
        { body: 'Review requested.\n\nSummary: old\n\nEvidence: old' },
        { body: 'Review requested.\r\n\r\nSummary: new\r\n\r\nEvidence: ok' },
      ]),
    ).toEqual({ summary: 'new', evidence: 'ok' })
  })
})

describe('github-issues review.list', () => {
  it('lists open PRs whose source issue has needs-review, with summary, CI and files', async () => {
    const { invoke } = await plugin()
    const result = await invoke('review.list')
    expect(result.errors).toEqual([])
    expect(result.items).toEqual([
      {
        repo: REPO,
        projectId: 'p1',
        issue: { number: 5, title: 'Login bug', url: 'u5' },
        pr: {
          number: 12,
          title: 'Fix login',
          url: PR_URL,
          author: 'bot',
          createdAt: '2026-11-01T10:00:00Z',
          files: ['src/login.ts'],
          ci: 'passing',
        },
        summary: 'Fixed the redirect.',
        evidence: '12 tests pass',
      },
    ])
  })

  it('runs every gh call non-interactively with an explicit --repo', async () => {
    const { fake, invoke } = await plugin()
    await invoke('review.list')
    expect(fake.rawGhCalls.length).toBeGreaterThan(0)
    expect(
      fake.rawGhCalls.every(
        call => call.repo === REPO && call.env.includes('GH_PROMPT_DISABLED=1'),
      ),
    ).toBe(true)
  })

  it('returns an empty preview without touching GitHub', async () => {
    const { fake, invoke } = await plugin()
    expect(await invoke('review.list', {}, { ...VIEW, preview: true })).toEqual({
      items: [],
      errors: [],
      preview: true,
    })
    await expect(
      invoke('review.merge', { projectId: 'p1', number: 5, pr: 12 }, { ...VIEW, preview: true }),
    ).rejects.toThrow(/preview/)
    expect(fake.ghCalls).toEqual([])
  })
})

describe('github-issues review decisions only through the view', () => {
  it('has no review command in the manifest, and runCommand refuses them', async () => {
    const manifest = JSON.parse(readFileSync('plugins/github-issues/opencove.plugin.json', 'utf8'))
    const ids: string[] = manifest.contributes.commands.map((command: { id: string }) => command.id)
    expect(ids.filter(id => id.startsWith('review.') || /merge/.test(id))).toEqual([])
    const { backend, fake } = await plugin()
    await Promise.all(
      ['review.merge', 'review.close', 'review.request-changes'].map(id =>
        expect(
          backend.runCommand(id, { projectId: 'p1', number: 5, pr: 12 }, null),
        ).rejects.toThrow(/Unknown command/),
      ),
    )
    expect(
      ghLines(fake.ghCalls).some(
        line => line.startsWith('pr merge') || line.startsWith('pr close'),
      ),
    ).toBe(false)
  })

  it('never renders service text with innerHTML', () => {
    expect(readFileSync('plugins/github-issues/view/view.js', 'utf8')).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML/,
    )
  })
})

describe('github-issues review.merge', () => {
  it('re-reads the PR, squash-merges it and closes the issue through issue.close', async () => {
    const { fake, invoke } = await plugin({ nodes: [task(null)] })
    const result = await invoke('review.merge', { projectId: 'p1', number: 5, pr: 12 })
    expect(result).toMatchObject({ number: 5, pr: 12, closed: true, taskNodeId: 'task-5' })
    const lines = ghLines(fake.ghCalls)
    expect(lines.indexOf('pr merge 12 --squash')).toBeGreaterThan(
      lines.findIndex(line => line.startsWith('pr view 12')),
    )
    expect(lines).toContain('issue close 5')
  })

  it('refuses a second merge while the first is running', async () => {
    const { fake, invoke } = await plugin()
    const first = invoke('review.merge', { projectId: 'p1', number: 5, pr: 12 })
    await expect(
      invoke('review.merge', { projectId: 'p1', number: 5, pr: 12 }),
    ).rejects.toMatchObject({ code: 'merge-in-progress' })
    await first
    expect(ghLines(fake.ghCalls).filter(line => line === 'pr merge 12 --squash')).toHaveLength(1)
  })

  it('does not merge again when the PR is already merged, and still closes the issue', async () => {
    const { fake, invoke } = await plugin({ gh: ghFor({ state: 'MERGED' }) })
    await invoke('review.merge', { projectId: 'p1', number: 5, pr: 12 })
    const lines = ghLines(fake.ghCalls)
    expect(lines).not.toContain('pr merge 12 --squash')
    expect(lines).toContain('issue close 5')
  })

  it('refuses a closed PR and a PR that does not fix the issue', async () => {
    const closed = await plugin({ gh: ghFor({ state: 'CLOSED' }) })
    await expect(
      closed.invoke('review.merge', { projectId: 'p1', number: 5, pr: 12 }),
    ).rejects.toMatchObject({ code: 'pr-not-open' })
    const other = await plugin()
    await expect(
      other.invoke('review.merge', { projectId: 'p1', number: 6, pr: 12 }),
    ).rejects.toMatchObject({ code: 'pr-not-linked' })
    expect(
      ghLines([...closed.fake.ghCalls, ...other.fake.ghCalls]).some(
        line => line.startsWith('pr merge') || line.startsWith('issue close'),
      ),
    ).toBe(false)
  })
})

describe('github-issues review.request-changes', () => {
  const params = { projectId: 'p1', number: 5, pr: 12, body: 'Add a test\nfor the redirect.' }

  it('comments on the PR, removes needs-review and writes to the running agent', async () => {
    const { fake, invoke } = await plugin({
      nodes: [task('agent-5'), agent],
      sessions: { 'agent-5': 'running' },
    })
    const result = await invoke('review.request-changes', params)
    expect(result).toMatchObject({ returnedTo: 'running-agent', agentNodeId: 'agent-5' })
    const lines = ghLines(fake.ghCalls)
    expect(lines).toContain(
      'pr comment 12 --body Changes requested in the review queue:\n\nAdd a test\nfor the redirect.',
    )
    expect(lines).toContain('issue edit 5 --remove-label needs-review')
    expect(fake.writes).toEqual([
      {
        nodeId: 'agent-5',
        data: '[github-issues] Changes were requested on PR #12 for issue #5: Add a test for the redirect. Fix them in this worktree and push to the same branch.',
      },
      { nodeId: 'agent-5', data: '\r' },
    ])
    expect(fake.launches).toEqual([])
  })

  it('relaunches a stopped agent in the same Space, never creating a worktree', async () => {
    const { fake, invoke } = await plugin({
      nodes: [task('agent-5'), agent],
      sessions: { 'agent-5': 'stopped' },
    })
    const result = await invoke('review.request-changes', params)
    expect(result).toMatchObject({ returnedTo: 'relaunched', spaceId: 'space-5' })
    expect(fake.closed).toEqual(['agent-5'])
    expect(fake.launches).toHaveLength(1)
    expect(fake.launches[0]).toMatchObject({
      target: { projectId: 'p1', spaceId: 'space-5' },
      taskNodeId: 'task-5',
    })
    expect(String(fake.launches[0].prompt)).toContain('Changes were requested on PR #12')
    // No worktree or Space creation: no opencove CLI call and no new node besides the agent.
    expect(fake.processCalls).toEqual([])
    expect(fake.created).toEqual([])
  })

  it('requires a comment', async () => {
    const { fake, invoke } = await plugin()
    await expect(invoke('review.request-changes', { ...params, body: '  ' })).rejects.toThrow(
      /body/,
    )
    expect(fake.ghCalls).toEqual([])
  })
})

describe('github-issues review.close', () => {
  it('closes the PR with the comment and removes needs-review, leaving the issue open', async () => {
    const { fake, invoke } = await plugin()
    await invoke('review.close', { projectId: 'p1', number: 5, pr: 12, body: 'Wrong approach.' })
    const lines = ghLines(fake.ghCalls)
    expect(lines).toContain('pr close 12 --comment Wrong approach.')
    expect(lines).toContain('issue edit 5 --remove-label needs-review')
    expect(lines).not.toContain('issue close 5')
  })
})
