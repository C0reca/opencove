import { afterEach, describe, expect, it, vi } from 'vitest'
import { tryHandleSpaceCommands } from '../../../src/app/cli/commands/space.mjs'

type CapturedRequest = {
  id: string
  kind: string
  payload: Record<string, unknown> | null
}

function stubInvoke(envelope: Record<string, unknown>): CapturedRequest[] {
  const requests: CapturedRequest[] = []
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : ''
    requests.push(JSON.parse(body) as CapturedRequest)
    return new Response(JSON.stringify({ __opencoveControlEnvelope: true, ...envelope }))
  })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  return requests
}

function stubExitAndStderr(): { stderr: () => string } {
  let stderr = ''
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  })
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`)
  }) as never)
  return { stderr: () => stderr }
}

async function run(args: string[]): Promise<boolean> {
  return await tryHandleSpaceCommands({
    command: 'space',
    args,
    connection: { hostname: '127.0.0.1', port: 1, token: 'token' },
    pretty: false,
    timeoutMs: 1_000,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('CLI space create', () => {
  it('wraps space.createChild with the parent, name and project', async () => {
    const requests = stubInvoke({ ok: true, value: { childSpace: { id: 'child-1' } } })

    const handled = await run([
      'space',
      'create',
      '--parent',
      'space-1',
      '--name',
      'issue-12-fix-foo',
      '--project',
      'p1',
    ])

    expect(handled).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      id: 'space.createChild',
      kind: 'command',
      payload: { parentSpaceId: 'space-1', name: 'issue-12-fix-foo', projectId: 'p1' },
    })
  })

  it('omits name and project when they are not given', async () => {
    const requests = stubInvoke({ ok: true, value: { childSpace: { id: 'child-1' } } })

    await run(['space', 'create', '--parent', 'space-1'])

    expect(requests[0].payload).toEqual({ parentSpaceId: 'space-1' })
  })

  it('exits with usage error and sends nothing when --parent is missing', async () => {
    const requests = stubInvoke({ ok: true, value: {} })
    stubExitAndStderr()

    await expect(run(['space', 'create', '--name', 'x'])).rejects.toThrow('exit 2')
    expect(requests).toHaveLength(0)
  })

  it('explains a parent without a canvas rect and exits 1', async () => {
    stubInvoke({
      ok: false,
      error: {
        code: 'common.invalid_input',
        debugMessage: 'space.createChild failed: parent_missing_rect',
      },
    })
    const { stderr } = stubExitAndStderr()

    await expect(run(['space', 'create', '--parent', 'space-1'])).rejects.toThrow('exit 1')
    expect(stderr()).toContain('space-1')
    expect(stderr()).toContain('no canvas position')
  })

  it('prints other failures as JSON and exits 1', async () => {
    stubInvoke({
      ok: false,
      error: { code: 'space.not_found', debugMessage: 'space.createChild: unknown parent' },
    })
    stubExitAndStderr()

    await expect(run(['space', 'create', '--parent', 'nope'])).rejects.toThrow('exit 1')
  })

  it('ignores other space subcommands', async () => {
    const requests = stubInvoke({ ok: true, value: {} })

    expect(await run(['space', 'list'])).toBe(false)
    expect(requests).toHaveLength(0)
  })
})
