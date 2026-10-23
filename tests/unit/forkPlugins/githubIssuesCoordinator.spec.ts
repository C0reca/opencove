import { describe, expect, it } from 'vitest'
import { activate } from '../../../plugins/github-issues/main.mjs'
import { coordinatorPrompt } from '../../../plugins/github-issues/lib/coordinator.mjs'
import {
  createFakeHost,
  failed,
  ok,
  remotes,
  type FakeNode,
  type GhReply,
} from './githubIssuesFakeHost'

const coordinatorNode = (id: string): FakeNode => ({
  id,
  kind: 'agent',
  title: 'Issue coordinator',
  data: { kind: 'agent', prompt: '' },
})

const ROOT_SPACE = {
  id: 'space-root',
  name: 'Main',
  parentSpaceId: null,
  directoryPath: '/Users/me/repo',
  sortOrder: 0,
}

// `opencove space list` answers with the root Space plus any extra Spaces the test names.
function cliFor(extraSpaces: Array<Record<string, unknown>> = []) {
  return (args: string[], command = 'gh'): GhReply => {
    if (command !== 'opencove') {
      return args.join(' ') === 'remote -v' ? ok(remotes('C0reca/opencove')) : failed('unused')
    }
    if (args[0] === 'space' && args[1] === 'list') {
      return ok(JSON.stringify({ ok: true, value: { spaces: [ROOT_SPACE, ...extraSpaces] } }))
    }
    if (args[0] === 'space') {
      return ok('{"ok":true,"value":{"childSpace":{"id":"space-created"}}}')
    }
    return ok('{"ok":true}')
  }
}

async function runCoordinator(
  options: {
    nodes?: FakeNode[]
    sessions?: Record<string, string>
    prefs?: Record<string, string>
    spaces?: Array<Record<string, unknown>>
    workingDirectories?: Record<string, string>
  } = {},
) {
  const fake = createFakeHost({ gh: cliFor(options.spaces), ...options })
  const plugin = await activate({ host: fake.host, log: () => undefined })
  const run = (params: Record<string, unknown>, context: Record<string, unknown> | null = null) =>
    plugin.runCommand('coordinator.launch', params, context)
  return { fake, run }
}

const COORD_SPACE = {
  id: 'space-coord',
  name: 'issue-coordinator',
  parentSpaceId: 'space-root',
  directoryPath: '/Users/me/.opencove/worktrees/issue-coordinator',
  sortOrder: 1,
}

describe('github-issues coordinator.launch', () => {
  it('launches in its own worktree Space in the repository mode, which is normal by default', async () => {
    const { fake, run } = await runCoordinator()

    const result = await run({ projectId: 'p1' })

    expect(fake.processCalls.map(call => call.args.slice(0, 2).join(' '))).toEqual([
      'space list',
      'space create',
      'worktree create',
    ])
    expect(fake.launches).toHaveLength(1)
    expect(fake.launches[0]).toMatchObject({
      target: { projectId: 'p1', spaceId: 'space-created' },
      title: 'Issue coordinator',
      provider: 'claude-code',
      agentPermissionMode: 'default',
    })
    expect(fake.launches[0]).not.toHaveProperty('agentFullAccess')
    expect(result).toEqual({
      nodeId: expect.any(String),
      projectId: 'p1',
      spaceId: 'space-created',
      reused: false,
      configuredMode: 'normal',
      effectiveMode: 'normal',
      reason: null,
      agentPermissionMode: 'default',
    })
  })

  it('uses the repository mode: full when permission-modes says so, auto for an auto wildcard', async () => {
    const full = await runCoordinator({ prefs: { 'permission-modes': 'c0reca/opencove: full' } })
    await full.run({ projectId: 'p1' })
    expect(full.fake.launches[0].agentPermissionMode).toBe('full')

    const auto = await runCoordinator({ prefs: { 'permission-modes': 'C0reca/*: auto' } })
    await auto.run({ projectId: 'p1' })
    expect(auto.fake.launches[0].agentPermissionMode).toBe('auto')
  })

  it('migrates a legacy auto-approve-repos entry to the full mode', async () => {
    const { fake, run } = await runCoordinator({
      prefs: { 'auto-approve-repos': 'c0reca/opencove' },
    })

    await run({ projectId: 'p1' })

    expect(fake.launches[0].agentPermissionMode).toBe('full')
  })

  it('reuses the issue-coordinator Space by name and never creates a second one', async () => {
    const { fake, run } = await runCoordinator({ spaces: [COORD_SPACE] })

    await run({ projectId: 'p1' })

    expect(fake.processCalls.map(call => call.args.slice(0, 2).join(' '))).toEqual(['space list'])
    expect(fake.launches[0].target).toEqual({ projectId: 'p1', spaceId: 'space-coord' })
  })

  it('gives a reused coordinator Space whose worktree was archived a new worktree', async () => {
    const archived = { ...COORD_SPACE, directoryPath: '/Users/me/repo' }
    const { fake, run } = await runCoordinator({ spaces: [archived] })

    await run({ projectId: 'p1' })

    expect(fake.processCalls.map(call => call.args.join(' '))).toEqual([
      'space list --project p1',
      'worktree create --space space-coord --name issue-coordinator',
    ])
    expect(fake.launches[0].target).toEqual({ projectId: 'p1', spaceId: 'space-coord' })
  })

  it('never writes the guard or launches when the Space resolves to the main checkout', async () => {
    const { fake, run } = await runCoordinator({
      spaces: [COORD_SPACE],
      workingDirectories: { 'space-coord': '/Users/me/repo' },
    })

    await expect(run({ projectId: 'p1' })).rejects.toMatchObject({ code: 'not-a-worktree' })
    expect(fake.files.size).toBe(0)
    expect(fake.launches).toHaveLength(0)
  })

  it('writes the guard file into the coordinator worktree before it launches', async () => {
    const { fake, run } = await runCoordinator({ spaces: [COORD_SPACE] })

    await run({ projectId: 'p1' })

    const settings = fake.files.get('space-coord:.claude/settings.local.json')
    expect(settings).toBeDefined()
    expect(JSON.parse(String(settings)).permissions.deny).toContain('Bash(gh pr merge:*)')
    expect(fake.launches[0].target).toEqual({ projectId: 'p1', spaceId: 'space-coord' })
  })

  it('ignores the Space the Sidebar menu was opened from', async () => {
    const { fake, run } = await runCoordinator({ spaces: [COORD_SPACE] })

    await run({ projectId: 'p1' }, { host: { projectId: 'p1', spaceId: 'space-other' } })

    expect(fake.launches[0].target).toEqual({ projectId: 'p1', spaceId: 'space-coord' })
  })

  it('tells the agent to load the skill and gives it the project', async () => {
    const { fake, run } = await runCoordinator()

    await run({ projectId: 'p1' })

    const prompt = String(fake.launches[0].prompt)
    expect(prompt).toContain('opencove plugin skill github-issues issue-coordinator')
    expect(prompt).toContain('project p1')
    expect(prompt).toBe(coordinatorPrompt('p1'))
  })

  it('reuses a coordinator whose session is still running and launches none', async () => {
    const { fake, run } = await runCoordinator({
      nodes: [coordinatorNode('coord-live')],
      sessions: { 'coord-live': 'running' },
    })

    const result = await run({ projectId: 'p1' })

    expect(fake.launches).toHaveLength(0)
    expect(result).toEqual({
      nodeId: 'coord-live',
      projectId: 'p1',
      reused: true,
      configuredMode: null,
      effectiveMode: null,
      reason: null,
      agentPermissionMode: null,
    })
  })

  it('launches a new coordinator when the existing one is no longer running', async () => {
    const { fake, run } = await runCoordinator({
      nodes: [coordinatorNode('coord-old')],
      sessions: { 'coord-old': 'exited' },
    })

    const result = await run({ projectId: 'p1' })

    expect(fake.launches).toHaveLength(1)
    expect(result).toMatchObject({ reused: false, agentPermissionMode: 'default' })
  })

  it('requires a projectId', async () => {
    const { fake, run } = await runCoordinator()

    await expect(run({})).rejects.toMatchObject({ code: 'invalid-params' })
    expect(fake.launches).toHaveLength(0)
  })

  it('coordinatorPrompt is the same text for every launch of a project', () => {
    expect(coordinatorPrompt('p9')).toContain('project p9')
  })
})
