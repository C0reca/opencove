import { beforeEach, describe, expect, it } from 'vitest'
import {
  describeFailure,
  resetGhPathCache,
  runGh,
  runTool,
} from '../../../plugins/github-issues/lib/runGh.mjs'
import { classifyOpencoveFailure } from '../../../plugins/github-issues/lib/worktree.mjs'

type Reply = { exitCode: number; output?: string; error?: string }

// Minimal host: `answer` sees the program and its args after the /usr/bin/env launcher.
function hostAnswering(answer: (program: string, args: string[]) => Reply) {
  const calls: Array<{ command: string; args: string[] }> = []
  const replies = new Map<string, Reply>()
  const host = {
    operations: {
      start: async ({ command, args }: { command: string; args: string[] }) => {
        calls.push({ command, args })
        const start = args.findIndex(arg => !/^[A-Z_]+=/.test(arg))
        const id = `op-${calls.length}`
        replies.set(id, answer(args[start] ?? '', args.slice(start + 1)))
        return { operationId: id }
      },
      get: async ({ operationId }: { operationId: string }) => ({
        status: 'completed',
        output: '',
        error: '',
        ...replies.get(operationId),
      }),
      cancel: async () => ({}),
    },
  }
  return { host, calls }
}

const target = { projectId: 'p1' }

describe('github-issues gh launcher', () => {
  beforeEach(() => resetGhPathCache())

  it('runs gh through env with a non-interactive, colourless environment and --repo', async () => {
    const { host, calls } = hostAnswering(program =>
      program === '/bin/sh' ? { exitCode: 0, output: '/opt/homebrew/bin/gh\r\n' } : { exitCode: 0 },
    )

    const result = await runGh(host, target, ['issue', 'list'], { repo: 'o/r' })

    expect(result.ok).toBe(true)
    const last = calls.at(-1)!
    expect(last.command).toBe('/usr/bin/env')
    expect(last.args).toEqual(
      expect.arrayContaining(['NO_COLOR=1', 'GH_PROMPT_DISABLED=1', 'GH_PAGER=cat', 'TERM=dumb']),
    )
    expect(last.args.slice(-5)).toEqual(['/opt/homebrew/bin/gh', 'issue', 'list', '--repo', 'o/r'])
  })

  it('falls back through known install paths when the login shell cannot find gh', async () => {
    const probed: string[] = []
    const { host, calls } = hostAnswering((program, args) => {
      if (program === '/bin/sh') {
        return { exitCode: 1 }
      }
      if (args[0] === '--version') {
        probed.push(program)
        return { exitCode: program === '/usr/local/bin/gh' ? 0 : 127 }
      }
      return { exitCode: 0 }
    })

    await runGh(host, target, ['issue', 'list'])
    await runGh(host, target, ['issue', 'list'])

    expect(probed).toEqual(['/opt/homebrew/bin/gh', '/usr/local/bin/gh'])
    expect(calls.filter(call => call.args.includes('list'))).toHaveLength(2)
    expect(calls.at(-1)!.args).toContain('/usr/local/bin/gh')
  })

  it('reports gh-missing when no candidate runs, and retries the lookup next time', async () => {
    let installed = false
    const { host } = hostAnswering((program, args) =>
      program === '/bin/sh' || args[0] === '--version'
        ? { exitCode: installed && program === 'gh' ? 0 : 127 }
        : { exitCode: 0 },
    )

    const missing = await runGh(host, target, ['issue', 'list'])
    expect(missing).toEqual({ ok: false, error: expect.objectContaining({ code: 'gh-missing' }) })

    installed = true
    expect((await runGh(host, target, ['issue', 'list'])).ok).toBe(true)
  })

  // Regression for #25: opencove ran as a bare command and failed with "exit 1" and no detail.
  it('runs opencove by its resolved path through env, like gh', async () => {
    const { host, calls } = hostAnswering(program =>
      program === '/bin/sh'
        ? { exitCode: 0, output: '/Users/me/.local/bin/opencove\r\n' }
        : { exitCode: 0 },
    )

    expect((await runTool(host, target, 'opencove', ['space', 'list'])).ok).toBe(true)
    const last = calls.at(-1)!
    expect(last.command).toBe('/usr/bin/env')
    expect(last.args).toContain('NO_COLOR=1')
    expect(last.args.slice(-3)).toEqual(['/Users/me/.local/bin/opencove', 'space', 'list'])
  })

  it('reports a missing opencove CLI with every place it looked', async () => {
    const { host } = hostAnswering(() => ({ exitCode: 1 }))

    const result = await runTool(host, target, 'opencove', ['space', 'list'])

    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('cli-missing')
    expect(result.error.message).toContain('/opt/homebrew/bin/opencove')
    expect(result.error.message).toContain('/.local/bin/opencove')
    expect(result.error.message).toContain('Install CLI')
  })

  it('never reports a failure without the exit code and some detail', () => {
    expect(describeFailure('git', { exitCode: 1 }).message).toBe('git failed (exit 1): (no output)')
    expect(classifyOpencoveFailure({ exitCode: 1 }).message).toBe(
      'opencove failed (exit 1): (no output)',
    )
    expect(
      classifyOpencoveFailure({ exitCode: 2, output: '\u001b[31merror\u001b[0m: bad\r\nnext' })
        .message,
    ).toBe('opencove failed (exit 2): error: bad | next')
  })
})
