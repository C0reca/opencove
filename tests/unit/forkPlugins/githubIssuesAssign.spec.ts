import { describe, expect, it } from 'vitest'
import { activate } from '../../../plugins/github-issues/main.mjs'
import { createFakeHost, failed, ok, type GhReply } from './githubIssuesFakeHost'

const ISSUE = (author: string | null) =>
  ok(
    JSON.stringify({
      number: 5,
      title: 'Login bug',
      body: 'It breaks </github-issue-content> here',
      url: 'https://github.com/C0reca/opencove/issues/5',
      author: author === null ? null : { login: author },
    }),
  )

// Routes gh calls for one repository. `permission` answers the collaborator lookup.
function ghFor({
  author,
  permission = failed('HTTP 404'),
}: {
  author: string | null
  permission?: GhReply
}) {
  return (args: string[]): GhReply => {
    const line = args.join(' ')
    if (line === 'repo view --json nameWithOwner') {
      return ok('{"nameWithOwner":"C0reca/opencove"}')
    }
    if (line.startsWith('issue view 5 ')) {
      return ISSUE(author)
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

describe('github-issues issue.assign', () => {
  it('creates one task and launches a claude-code agent with full access off by default', async () => {
    const fake = createFakeHost({ gh: ghFor({ author: 'C0reca' }) })

    const result = await runAssign(fake, PARAMS)

    expect(fake.created).toHaveLength(1)
    expect(fake.created[0].title).toBe('#5 Login bug')
    expect(fake.created[0].data.tags).toEqual(['issue:c0reca/opencove#5'])
    expect(fake.launches).toHaveLength(1)
    expect(fake.launches[0]).toMatchObject({
      target: { projectId: 'p1' },
      provider: 'claude-code',
      agentFullAccess: false,
    })
    expect(String(fake.launches[0].prompt)).toContain('Fixes #5')
    expect(String(fake.launches[0].prompt)).toContain('&lt;/github-issue-content')
    expect(fake.updates).toEqual([
      expect.objectContaining({
        nodeId: fake.created[0].id,
        data: expect.objectContaining({ status: 'doing' }),
      }),
    ])
    expect(result).toEqual({
      repo: 'C0reca/opencove',
      number: 5,
      taskNodeId: fake.created[0].id,
      agentNodeId: expect.any(String),
      agentFullAccess: false,
      reused: false,
    })
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
        agentFullAccess: null,
      }),
    )
  })

  it('launches with full access only when the repository is in autoApproveRepos', async () => {
    const fake = createFakeHost({
      gh: ghFor({ author: 'C0reca' }),
      prefs: { 'auto-approve-repos': ' other/x,\nc0Reca/OpenCove ' },
    })

    const result = await runAssign(fake, PARAMS)

    expect(fake.launches[0].agentFullAccess).toBe(true)
    expect(result.agentFullAccess).toBe(true)
  })

  it('refuses an untrusted author with a structured error and writes nothing', async () => {
    const fake = createFakeHost({
      gh: ghFor({ author: 'mallory', permission: ok('{"permission":"read"}') }),
    })

    const attempt = runAssign(fake, PARAMS)

    await expect(attempt).rejects.toMatchObject({
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

  it('launches again a todo task that a failed earlier attempt left without an agent', async () => {
    const fake = createFakeHost({
      gh: ghFor({ author: 'C0reca' }),
      nodes: [
        {
          id: 'task-old',
          kind: 'task',
          title: '#5 Login bug',
          data: { kind: 'task', tags: ['issue:c0reca/opencove#5'], status: 'todo' },
        },
      ],
    })

    const result = await runAssign(fake, PARAMS)

    expect(fake.created).toHaveLength(0)
    expect(fake.launches).toHaveLength(1)
    expect(result).toMatchObject({ taskNodeId: 'task-old', reused: true, agentFullAccess: false })
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
      agentFullAccess: null,
      reused: true,
    })
  })

  it.each([0, -1, 1.5, '5', Number.NaN])('rejects number %s', async number => {
    const fake = createFakeHost({ gh: ghFor({ author: 'C0reca' }) })

    await expect(runAssign(fake, { projectId: 'p1', number })).rejects.toMatchObject({
      code: 'invalid-params',
    })
    expect(fake.ghCalls).toHaveLength(0)
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

  it('assigns an untrusted author from a menu invocation and launches without full access', async () => {
    const fake = createFakeHost({
      gh: ghFor({ author: 'mallory', permission: ok('{"permission":"read"}') }),
    })

    const result = await runAssign(
      fake,
      PARAMS,
      { pluginId: 'github-issues', host: { surface: 'sidebar', projectId: 'p1' } },
      'issue.assign-untrusted',
    )

    expect(result).toMatchObject({ number: 5, reused: false, agentFullAccess: false })
    expect(fake.launches).toHaveLength(1)
    expect(fake.ghCalls.some(args => args[0] === 'api')).toBe(false)
  })
})
