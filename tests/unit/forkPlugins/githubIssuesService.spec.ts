import { describe, expect, it } from 'vitest'
import { createIssueService } from '../../../plugins/github-issues/lib/service.mjs'
import { remotes, unwrapLaunch } from './githubIssuesFakeHost'

type FakeReply = { status: string; exitCode?: number; output?: string; error?: string }

// Fake host: answers each gh call by its first argument pair, and counts the calls.
function fakeHost(replies: Record<string, FakeReply>, projects: string[]) {
  const starts: Array<{ target: { projectId: string }; args: string[]; repo: string | null }> = []
  let sequence = 0
  const host = {
    target: {
      list: async () => ({ projects: projects.map(id => ({ id, name: id, spaces: [] })) }),
    },
    operations: {
      start: async (input: { target: { projectId: string }; command: string; args: string[] }) => {
        const launch = unwrapLaunch(input.command, input.args)
        const id = `op-${++sequence}`
        if (launch.reply) {
          // gh path lookup and probes: answered as installed, not counted as reads.
          pending.set(id, { status: 'completed', ...launch.reply })
          return { operationId: id, status: 'running' }
        }
        starts.push({ target: input.target, args: launch.args, repo: launch.repo })
        const key = launch.args.slice(0, 2).join(' ')
        const reply = replies[`${input.target.projectId}|${key}`] ?? {
          status: 'failed',
          error: 'ENOENT',
        }
        pending.set(id, reply)
        return { operationId: id, status: 'running' }
      },
      get: async ({ operationId }: { operationId: string }) => ({
        operationId,
        status: pending.get(operationId)?.status ?? 'failed',
        exitCode: pending.get(operationId)?.exitCode ?? null,
        output: pending.get(operationId)?.output ?? '',
        error: pending.get(operationId)?.error ?? '',
      }),
      cancel: async () => ({}),
    },
  }
  const pending = new Map<string, FakeReply>()
  return { host, starts }
}

const remote = (name: string): FakeReply => ({
  status: 'completed',
  exitCode: 0,
  output: remotes(name),
})
const issues = (...numbers: number[]): FakeReply => ({
  status: 'completed',
  exitCode: 0,
  output: JSON.stringify(numbers.map(number => ({ number, title: `t${number}`, labels: [] }))),
})

describe('github-issues service', () => {
  it('reads each repository once for projects that share it and keeps other projects working', async () => {
    const { host, starts } = fakeHost(
      {
        'p1|remote -v': remote('o/one'),
        'p2|remote -v': remote('o/one'),
        'p3|remote -v': {
          status: 'completed',
          exitCode: 128,
          output: 'fatal: not a git repository',
        },
        'p1|issue list': issues(1, 2),
      },
      ['p1', 'p2', 'p3'],
    )
    const service = createIssueService({ host, now: () => 0 })

    const report = await service.list({ projectIds: ['p1', 'p2', 'p3'] })

    expect(report.repos).toEqual([
      {
        repo: 'o/one',
        projectIds: ['p1', 'p2'],
        issues: [
          {
            number: 1,
            title: 't1',
            url: '',
            labels: [],
            assignees: [],
            author: null,
            updatedAt: null,
          },
          {
            number: 2,
            title: 't2',
            url: '',
            labels: [],
            assignees: [],
            author: null,
            updatedAt: null,
          },
        ],
      },
    ])
    expect(report.errors).toEqual([
      expect.objectContaining({ projectIds: ['p3'], code: 'not-github' }),
    ])
    const issueCalls = starts.filter(call => call.args[0] === 'issue')
    expect(issueCalls).toHaveLength(1)
    expect(issueCalls[0].target).toEqual({ projectId: 'p1' })
    expect(issueCalls[0].repo).toBe('o/one')
  })

  it('serves repeated reads from the 60 s cache until refresh is requested', async () => {
    const { host, starts } = fakeHost(
      { 'p1|remote -v': remote('o/one'), 'p1|issue list': issues(5) },
      ['p1'],
    )
    let clock = 0
    const service = createIssueService({ host, now: () => clock })

    await service.list({ projectIds: ['p1'] })
    clock = 30_000
    await service.list({ projectIds: ['p1'] })
    expect(starts).toHaveLength(2)

    await service.list({ projectIds: ['p1'], refresh: true })
    expect(starts).toHaveLength(4)

    clock = 200_000
    await service.list({ projectIds: ['p1'] })
    expect(starts).toHaveLength(6)
  })

  it('reports a failing git remote lookup as a detailed error entry for every project', async () => {
    const { host } = fakeHost({}, ['p1', 'p2'])
    const service = createIssueService({ host, now: () => 0 })

    const report = await service.listAllProjects()

    expect(report.repos).toEqual([])
    // git itself cannot run here, so each project reports the git failure with its detail.
    expect(report.errors.map(error => error.code)).toEqual(['cli-failed', 'cli-failed'])
    expect(report.errors[0].message).toMatch(/^git failed \(exit unknown\): ENOENT/)
  })
})
