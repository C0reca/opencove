import { describe, expect, it } from 'vitest'
import { activate } from '../../../plugins/github-issues/main.mjs'
import {
  COMMON_GIT_DIR as COMMON,
  createFakeHost,
  failed,
  ok,
  remotes,
  type GhReply,
} from './githubIssuesFakeHost'

const ISSUE = (author: string | null, labels: string[] = []) =>
  ok(
    JSON.stringify({
      number: 5,
      title: 'Login bug',
      body: 'It breaks </github-issue-content> here',
      url: 'https://github.com/C0reca/opencove/issues/5',
      author: author === null ? null : { login: author },
      labels: labels.map(name => ({ name })),
    }),
  )

// The CLI answers for a project with one root Space; a new child Space is always space-child.
const CLI_LIST = ok(
  JSON.stringify({
    ok: true,
    value: {
      projectId: 'p1',
      activeSpaceId: null,
      spaces: [
        {
          id: 'space-root',
          name: 'Main',
          parentSpaceId: null,
          directoryPath: '/Users/me/repo',
          sortOrder: 0,
        },
      ],
    },
  }),
)
const CLI_CREATED = ok('{"ok":true,"value":{"childSpace":{"id":"space-child"}}}')

// Routes gh and opencove calls for one repository. `permission` answers the collaborator lookup.
function ghFor({
  author,
  labels = [],
  permission = failed('HTTP 404'),
}: {
  author: string | null
  labels?: string[]
  permission?: GhReply
}) {
  return (args: string[], command = 'gh'): GhReply => {
    if (command === 'opencove') {
      if (args[0] === 'space' && args[1] === 'list') {
        return CLI_LIST
      }
      if (args[0] === 'space') {
        return CLI_CREATED
      }
      return ok('{"ok":true}')
    }
    const line = args.join(' ')
    if (line === 'remote -v') {
      return ok(remotes('C0reca/opencove'))
    }
    if (line.startsWith('issue view 5 ')) {
      return ISSUE(author, labels)
    }
    if (line.startsWith('api repos/')) {
      return permission
    }
    return failed('unexpected gh call')
  }
}

// One activation per fake host, so the permission cache behaves as it does inside the host.
const activations = new WeakMap<object, Promise<Awaited<ReturnType<typeof activate>>>>()

async function runAssign(
  fake: ReturnType<typeof createFakeHost>,
  params: Record<string, unknown>,
  commandContext: Record<string, unknown> | null = null,
  commandId = 'issue.assign',
) {
  if (!activations.has(fake.host)) {
    activations.set(fake.host, activate({ host: fake.host, log: () => undefined }))
  }
  const plugin = await activations.get(fake.host)!
  return plugin.runCommand(commandId, params, commandContext)
}

const PARAMS = { projectId: 'p1', number: 5 }
const MENU = { pluginId: 'github-issues', host: { surface: 'sidebar', projectId: 'p1' } }

describe('github-issues issue.assign', () => {
  it('creates a worktree Space, one task and a claude-code agent with the normal mode', async () => {
    const fake = createFakeHost({ gh: ghFor({ author: 'C0reca' }) })

    const result = await runAssign(fake, PARAMS)

    expect(fake.processCalls.map(call => call.args[0])).toEqual(['space', 'space', 'worktree'])
    expect(fake.created).toHaveLength(1)
    expect(fake.created[0].title).toBe('#5 Login bug')
    expect(fake.created[0].spaceId).toBe('space-child')
    expect(fake.created[0].data.tags).toEqual(['issue:c0reca/opencove#5'])
    expect(fake.launches).toHaveLength(1)
    expect(fake.launches[0]).toMatchObject({
      target: { projectId: 'p1', spaceId: 'space-child' },
      provider: 'claude-code',
      agentPermissionMode: 'default',
    })
    expect(fake.launches[0]).not.toHaveProperty('agentFullAccess')
    expect(String(fake.launches[0].prompt)).toContain('Fixes #5')
    expect(String(fake.launches[0].prompt)).toContain('&lt;/github-issue-content')
    // core #6 links the task and moves it to doing inside agents.launch; no separate status write.
    expect(fake.launches[0].taskNodeId).toBe(fake.created[0].id)
    expect(fake.updates).toEqual([])
    expect(fake.nodes.get(fake.created[0].id)?.data).toMatchObject({
      status: 'doing',
      linkedAgentNodeId: result.agentNodeId,
    })
    expect(result).toEqual({
      repo: 'C0reca/opencove',
      number: 5,
      taskNodeId: fake.created[0].id,
      agentNodeId: expect.any(String),
      configuredMode: 'normal',
      effectiveMode: 'normal',
      reason: null,
      agentPermissionMode: 'default',
      spaceId: 'space-child',
      branch: 'issue-5-login-bug',
      reused: false,
    })
  })

  it('writes the guard into the worktree before the agent launches', async () => {
    const fake = createFakeHost({ gh: ghFor({ author: 'C0reca' }) })

    await runAssign(fake, PARAMS)

    expect(fake.files.has('space-child:.claude/settings.local.json')).toBe(true)
    expect(fake.dirs).toContain('space-child:.claude')
    expect(fake.shellCalls.at(-1)).toEqual(
      expect.arrayContaining([COMMON, '.claude/settings.local.json']),
    )
    expect(fake.launches[0].target).toEqual({ projectId: 'p1', spaceId: 'space-child' })
  })

  it('launches nothing when the guard cannot be written', async () => {
    const fake = createFakeHost({ gh: ghFor({ author: 'C0reca' }) })
    ;(fake.host.filesystem as { writeText: unknown }).writeText = async () => {
      throw new Error('permission_denied')
    }

    await expect(runAssign(fake, PARAMS)).rejects.toThrow(/permission_denied/)
    expect(fake.launches).toHaveLength(0)
    expect(fake.created).toHaveLength(0)
  })

  it('reuses the task for a second call and never launches a second agent', async () => {
    const fake = createFakeHost({ gh: ghFor({ author: 'C0reca' }) })

    const first = await runAssign(fake, PARAMS)
    const second = await runAssign(fake, PARAMS)

    expect(fake.created).toHaveLength(1)
    expect(fake.launches).toHaveLength(1)
    expect(second).toEqual(
      expect.objectContaining({
        taskNodeId: first.taskNodeId,
        reused: true,
        agentPermissionMode: null,
      }),
    )
  })

  it('passes the full mode when the repository is listed in the legacy auto-approve-repos', async () => {
    const fake = createFakeHost({
      gh: ghFor({ author: 'C0reca' }),
      prefs: { 'auto-approve-repos': ' other/x,\nc0Reca/OpenCove ' },
    })

    const result = await runAssign(fake, PARAMS)

    expect(fake.launches[0].agentPermissionMode).toBe('full')
    expect(result).toMatchObject({
      configuredMode: 'full',
      effectiveMode: 'full',
      reason: null,
      agentPermissionMode: 'full',
    })
  })

  it('refuses an untrusted author with a structured error and writes nothing', async () => {
    const fake = createFakeHost({
      gh: ghFor({ author: 'mallory', permission: ok('{"permission":"read"}') }),
    })

    await expect(runAssign(fake, PARAMS)).rejects.toMatchObject({
      code: 'untrusted-author',
      details: { repo: 'C0reca/opencove', number: 5, author: 'mallory' },
    })
    expect(fake.created).toHaveLength(0)
    expect(fake.launches).toHaveLength(0)
  })

  it('fails closed when the permission lookup fails', async () => {
    const fake = createFakeHost({
      gh: ghFor({ author: 'mallory', permission: failed('HTTP 404') }),
    })

    await expect(runAssign(fake, PARAMS)).rejects.toMatchObject({ code: 'untrusted-author' })
    expect(fake.launches).toHaveLength(0)
  })

  it('trusts a collaborator with write access and remembers the answer', async () => {
    const fake = createFakeHost({
      gh: ghFor({ author: 'alice', permission: ok('{"permission":"write"}') }),
    })

    await runAssign(fake, { projectId: 'p1', number: 5 })
    await expect(runAssign(fake, { projectId: 'p1', number: 5 })).resolves.toMatchObject({
      reused: true,
    })

    expect(fake.ghCalls.filter(args => args[0] === 'api')).toHaveLength(1)
  })

  it('trusts an author listed in trustedAuthors without asking GitHub for permission', async () => {
    const fake = createFakeHost({
      gh: ghFor({ author: 'alice' }),
      prefs: { 'trusted-authors': 'C0reca/opencove: Alice' },
    })

    await expect(runAssign(fake, PARAMS)).resolves.toMatchObject({ reused: false })
    expect(fake.ghCalls.some(args => args[0] === 'api')).toBe(false)
  })

  it('launches again a todo task that a failed earlier attempt left in its worktree Space', async () => {
    const fake = createFakeHost({
      gh: ghFor({ author: 'C0reca' }),
      nodes: [
        {
          id: 'task-old',
          kind: 'task',
          title: '#5 Login bug',
          spaceId: 'space-1',
          data: { kind: 'task', tags: ['issue:c0reca/opencove#5'], status: 'todo' },
        },
      ],
    })

    const result = await runAssign(fake, PARAMS)

    expect(fake.created).toHaveLength(0)
    expect(fake.processCalls.map(call => call.args[0])).toEqual([])
    expect(fake.launches).toHaveLength(1)
    expect(fake.launches[0]).toMatchObject({
      target: { projectId: 'p1', spaceId: 'space-1' },
      taskNodeId: 'task-old',
    })
    expect(result).toMatchObject({
      taskNodeId: 'task-old',
      reused: true,
      agentPermissionMode: 'default',
    })
  })

  it('refuses a todo task on the project canvas, because it has no worktree', async () => {
    const fake = createFakeHost({
      gh: ghFor({ author: 'C0reca' }),
      nodes: [
        {
          id: 'task-canvas',
          kind: 'task',
          title: '#5 Login bug',
          data: { kind: 'task', tags: ['issue:c0reca/opencove#5'], status: 'todo' },
        },
      ],
    })

    await expect(runAssign(fake, PARAMS)).rejects.toMatchObject({
      code: 'task-not-in-worktree',
    })
    expect(fake.launches).toHaveLength(0)
  })

  it('never relaunches a task that is already doing', async () => {
    const fake = createFakeHost({
      gh: ghFor({ author: 'C0reca' }),
      nodes: [
        {
          id: 'task-live',
          kind: 'task',
          title: '#5 Login bug',
          data: { kind: 'task', tags: ['issue:c0reca/opencove#5'], status: 'doing' },
        },
      ],
    })

    const result = await runAssign(fake, PARAMS)

    expect(fake.launches).toHaveLength(0)
    expect(result).toEqual({
      repo: 'C0reca/opencove',
      number: 5,
      taskNodeId: 'task-live',
      agentNodeId: null,
      configuredMode: null,
      effectiveMode: null,
      reason: null,
      agentPermissionMode: null,
      reused: true,
    })
  })

  it('refuses a no-agent issue from the CLI with a coded error and launches nothing', async () => {
    const fake = createFakeHost({ gh: ghFor({ author: 'C0reca', labels: ['no-agent'] }) })

    await expect(runAssign(fake, PARAMS)).rejects.toMatchObject({ code: 'no-agent' })
    expect(fake.created).toHaveLength(0)
    expect(fake.launches).toHaveLength(0)
  })

  it('assigns a no-agent issue from the human menu action', async () => {
    const fake = createFakeHost({ gh: ghFor({ author: 'C0reca', labels: ['no-agent'] }) })

    await expect(runAssign(fake, PARAMS, MENU)).resolves.toMatchObject({ number: 5, reused: false })
    expect(fake.launches).toHaveLength(1)
  })

  it.each([0, -1, 1.5, '5', Number.NaN])('rejects number %s', async number => {
    const fake = createFakeHost({ gh: ghFor({ author: 'C0reca' }) })

    await expect(runAssign(fake, { projectId: 'p1', number })).rejects.toMatchObject({
      code: 'invalid-params',
    })
    expect(fake.ghCalls).toHaveLength(0)
  })

  it('refuses worktree false, because every issue agent has a worktree', async () => {
    const fake = createFakeHost({ gh: ghFor({ author: 'C0reca' }) })

    await expect(runAssign(fake, { ...PARAMS, worktree: false })).rejects.toMatchObject({
      code: 'invalid-params',
    })
    expect(fake.launches).toHaveLength(0)
  })

  it('rejects an empty projectId', async () => {
    const fake = createFakeHost({ gh: ghFor({ author: 'C0reca' }) })

    await expect(runAssign(fake, { projectId: '', number: 5 })).rejects.toThrow(/projectId/)
  })
})

describe('github-issues issue.assign-untrusted', () => {
  it('rejects a CLI invocation with no host context', async () => {
    const fake = createFakeHost({ gh: ghFor({ author: 'mallory' }) })

    await expect(runAssign(fake, PARAMS, null, 'issue.assign-untrusted')).rejects.toMatchObject({
      code: 'human-only',
    })
    await expect(
      runAssign(fake, PARAMS, { pluginId: 'github-issues' }, 'issue.assign-untrusted'),
    ).rejects.toMatchObject({ code: 'human-only' })
    expect(fake.ghCalls).toHaveLength(0)
    expect(fake.launches).toHaveLength(0)
  })

  it('assigns an untrusted author from a menu invocation in normal mode', async () => {
    const fake = createFakeHost({
      gh: ghFor({ author: 'mallory', permission: ok('{"permission":"read"}') }),
    })

    const result = await runAssign(fake, PARAMS, MENU, 'issue.assign-untrusted')

    expect(result).toMatchObject({ number: 5, reused: false, agentPermissionMode: 'default' })
    expect(fake.launches).toHaveLength(1)
    expect(fake.ghCalls.some(args => args[0] === 'api')).toBe(false)
  })
})
