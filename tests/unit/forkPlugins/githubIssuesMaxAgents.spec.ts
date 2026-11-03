import { describe, expect, it } from 'vitest'
import { activate } from '../../../plugins/github-issues/main.mjs'
import {
  isActiveAgentRow,
  maxAgentsFor,
  parseMaxAgents,
} from '../../../plugins/github-issues/lib/limits.mjs'
import { createFakeHost, failed, ok, remotes, type FakeNode } from './githubIssuesFakeHost'

const issue = (number: number) =>
  ok(
    JSON.stringify({
      number,
      title: `Issue ${number}`,
      body: '',
      url: `https://github.com/C0reca/opencove/issues/${number}`,
      author: { login: 'C0reca' },
      labels: [],
    }),
  )

const SPACES = ok(
  JSON.stringify({
    ok: true,
    value: {
      projectId: 'p1',
      activeSpaceId: null,
      spaces: [
        { id: 'root', name: 'Main', parentSpaceId: null, directoryPath: '/r', sortOrder: 0 },
      ],
    },
  }),
)

function gh(args: string[], command = 'gh') {
  if (command === 'opencove') {
    if (args[0] === 'space' && args[1] === 'list') {
      return SPACES
    }
    return args[0] === 'space'
      ? ok('{"ok":true,"value":{"childSpace":{"id":"space-child"}}}')
      : ok('{"ok":true}')
  }
  const line = args.join(' ')
  if (line === 'remote -v') {
    return ok(remotes('C0reca/opencove'))
  }
  const view = /^issue view (\d+) /.exec(line)
  return view ? issue(Number(view[1])) : failed('unexpected gh call')
}

// An issue task in its own Space, linked to its agent node `a<N>`.
const agentNode = (n: number): FakeNode => ({
  id: `a${n}`,
  kind: 'agent',
  title: `#${n}`,
  spaceId: `s${n}`,
  status: 'running',
  data: { kind: 'agent', prompt: '' },
})
const issueTask = (n: number): FakeNode => ({
  id: `t${n}`,
  kind: 'task',
  title: `#${n}`,
  spaceId: `s${n}`,
  data: {
    kind: 'task',
    tags: [`issue:c0reca/opencove#${n}`],
    status: 'doing',
    linkedAgentNodeId: `a${n}`,
  },
})

async function setup(options: {
  prefs?: Record<string, string>
  agentStates?: Record<string, string>
  issues?: number[]
}) {
  const fake = createFakeHost({
    gh,
    prefs: options.prefs,
    agentStates: options.agentStates,
    nodes: (options.issues ?? []).flatMap(n => [issueTask(n), agentNode(n)]),
  })
  const plugin = await activate({ host: fake.host, log: () => undefined })
  const assign = (number: number, commandContext: Record<string, unknown> | null = null) =>
    plugin.runCommand('issue.assign', { projectId: 'p1', number }, commandContext)
  return { fake, assign }
}

describe('github-issues max-agents preference', () => {
  it('defaults to 2, the exact repository line wins over *, malformed lines are ignored', () => {
    expect(maxAgentsFor(parseMaxAgents(''), 'C0reca/opencove')).toBe(2)
    const limits = parseMaxAgents(
      '*: 4\nC0reca/OpenCove: 1\nC0reca/other: lots\nnot a line\nx/y: -1',
    )
    expect(maxAgentsFor(limits, 'c0reca/opencove')).toBe(1)
    expect(maxAgentsFor(limits, 'C0reca/other')).toBe(4)
    expect(maxAgentsFor(limits, 'x/y')).toBe(4)
    expect(maxAgentsFor(parseMaxAgents('C0reca/opencove: 0'), 'C0reca/opencove')).toBe(0)
  })

  it('counts working and waiting agents, and a live runtime without an observation', () => {
    const row = (agentState: string | null, runtimeStatus: string | null, agentNodeId = 'a') => ({
      agentNodeId,
      agentState,
      runtimeStatus,
    })
    expect(isActiveAgentRow(row('working', null))).toBe(true)
    expect(isActiveAgentRow(row('waiting', 'standby'))).toBe(true)
    expect(isActiveAgentRow(row('done', 'running'))).toBe(false)
    expect(isActiveAgentRow(row(null, 'running'))).toBe(true)
    expect(isActiveAgentRow(row(null, 'exited'))).toBe(false)
    expect(isActiveAgentRow(row('working', 'running', ''))).toBe(false)
  })
})

describe('github-issues issue.assign agent limit', () => {
  it('refuses with limit-reached at the default of 2 active agents and launches nothing', async () => {
    const { fake, assign } = await setup({
      issues: [1, 2],
      agentStates: { a1: 'working', a2: 'waiting' },
    })
    await expect(assign(5)).rejects.toMatchObject({
      code: 'limit-reached',
      details: { active: 2, max: 2, number: 5 },
    })
    expect(fake.launches).toHaveLength(0)
    expect(fake.processCalls).toHaveLength(0)
  })

  it('does not count an agent whose turn is done, and honours a higher limit', async () => {
    const done = await setup({ issues: [1, 2], agentStates: { a1: 'working', a2: 'done' } })
    await expect(done.assign(5)).resolves.toMatchObject({ number: 5, reused: false })

    const raised = await setup({
      issues: [1, 2],
      agentStates: { a1: 'working', a2: 'working' },
      prefs: { 'max-agents': 'C0reca/opencove: 3' },
    })
    await expect(raised.assign(5)).resolves.toMatchObject({ number: 5 })
  })

  it('still returns an already assigned issue at the limit, and lets a person assign from the sidebar', async () => {
    const { fake, assign } = await setup({
      issues: [1, 2],
      agentStates: { a1: 'working', a2: 'working' },
    })
    await expect(assign(1)).resolves.toMatchObject({ reused: true, agentNodeId: 'a1' })
    const menu = { pluginId: 'github-issues', host: { surface: 'sidebar', projectId: 'p1' } }
    await expect(assign(5, menu)).resolves.toMatchObject({ number: 5, reused: false })
    expect(fake.launches).toHaveLength(1)
  })

  it('runs two quick assigns one after the other, so they cannot both pass a limit of 1', async () => {
    // The first launch is a running node with no observation yet; it must already hold the slot.
    const { fake, assign } = await setup({ prefs: { 'max-agents': '*: 1' } })
    const results = await Promise.allSettled([assign(5), assign(6)])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect((results[1] as PromiseRejectedResult).reason.code).toBe('limit-reached')
    expect(fake.launches).toHaveLength(1)
  })
})
