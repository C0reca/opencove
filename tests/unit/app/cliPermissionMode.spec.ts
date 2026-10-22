import { afterEach, describe, expect, it, vi } from 'vitest'
import { tryHandleNodeControlCommands } from '../../../src/app/cli/commands/nodeControl.mjs'

type CapturedRequest = {
  payload: { data?: Record<string, unknown> }
}

function stubInvokeRequests(): CapturedRequest[] {
  const requests: CapturedRequest[] = []
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? init.body : ''
    requests.push(JSON.parse(body) as CapturedRequest)
    return new Response(
      JSON.stringify({ __opencoveControlEnvelope: true, ok: true, value: { ok: true } }),
    )
  })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  return requests
}

async function invokeNodeArgs(args: string[]): Promise<boolean> {
  return await tryHandleNodeControlCommands({
    command: 'node',
    args,
    connection: { hostname: '127.0.0.1', port: 1, token: 'token' },
    pretty: false,
    timeoutMs: 1_000,
  })
}

describe('opencove node create agent --permission-mode', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each(['default', 'auto', 'full'])(
    'forwards --permission-mode %s as agentPermissionMode',
    async mode => {
      const requests = stubInvokeRequests()

      await invokeNodeArgs([
        'node',
        'create',
        'agent',
        '--space',
        'space-1',
        '--permission-mode',
        mode,
      ])

      expect(requests[0].payload.data).toMatchObject({ agentPermissionMode: mode })
      expect(requests[0].payload.data).not.toHaveProperty('agentFullAccess')
    },
  )

  it('omits agentPermissionMode when --permission-mode is absent', async () => {
    const requests = stubInvokeRequests()

    await invokeNodeArgs(['node', 'create', 'agent', '--space', 'space-1', '--prompt', 'hi'])

    expect(requests[0].payload.data).not.toHaveProperty('agentPermissionMode')
  })

  it('rejects an unknown --permission-mode value before sending the request', async () => {
    const requests = stubInvokeRequests()
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`)
    }) as never)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await expect(
      invokeNodeArgs([
        'node',
        'create',
        'agent',
        '--space',
        'space-1',
        '--permission-mode',
        'bypass',
      ]),
    ).rejects.toThrow('exit 2')
    expect(requests).toHaveLength(0)
  })
})
