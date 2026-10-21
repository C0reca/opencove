import { describe, expect, it } from 'vitest'
import { activate } from '../../../plugins/github-issues/main.mjs'
import { createFakeHost, failed, ok, type GhReply } from './githubIssuesFakeHost'

const PR_URL = 'https://github.com/C0reca/opencove/pull/12'

// Routes the gh calls of the closing flows. `pull` answers `pr view`; writes succeed.
function ghFor(pull: Record<string, unknown> | 'missing') {
  return (args: string[]): GhReply => {
    const line = args.join(' ')
    if (line === 'repo view --json nameWithOwner') {
      return ok('{"nameWithOwner":"C0reca/opencove"}')
    }
    if (line.startsWith('pr view ')) {
      return pull === 'missing'
        ? failed('GraphQL: Could not resolve to a PullRequest with the number of 12.')
        : ok(JSON.stringify(pull))
    }
    if (
      line.startsWith('issue comment ') ||
      line.startsWith('issue close ') ||
      line.startsWith('issue edit ') ||
      line.startsWith('label create ')
    ) {
      return ok('')
    }
    return failed('unexpected gh call')
  }
}

const MERGED_FIXING_5 = {
  state: 'MERGED',
  url: PR_URL,
  closingIssuesReferences: [{ number: 5 }],
}

const TASK = {
  id: 'task-1',
  kind: 'task',
  title: '#5 Login bug',
  status: 'doing',
  data: {
    kind: 'task',
    requirement: 'Work on it',
    tags: ['issue:c0reca/opencove#5'],
    status: 'doing',
  },
}

async function pluginWith(gh: (args: string[]) => GhReply, nodes = [TASK]) {
  const fake = createFakeHost({ gh, nodes: nodes.map(node => ({ ...node })) })
  const plugin = await activate({ host: fake.host, log: () => undefined })
  const run = (commandId: string, params: Record<string, unknown>, context: unknown = null) =>
    plugin.runCommand(commandId, params, context)
  return { fake, run }
}

const writes = (calls: string[][]) =>
  calls.filter(args => ['issue', 'label'].includes(args[0]) && args[1] !== 'view')

describe('github-issues issue.close', () => {
  it('refuses a PR that is not merged and changes nothing', async () => {
    const { fake, run } = await pluginWith(ghFor({ ...MERGED_FIXING_5, state: 'OPEN' }))

    await expect(run('issue.close', { projectId: 'p1', number: 5, pr: 12 })).rejects.toMatchObject({
      code: 'pr-not-merged',
    })
    expect(writes(fake.ghCalls)).toEqual([])
  })

  it('refuses an absent PR', async () => {
    const { fake, run } = await pluginWith(ghFor('missing'))

    await expect(run('issue.close', { projectId: 'p1', number: 5, pr: 12 })).rejects.toMatchObject({
      code: 'pr-not-found',
    })
    expect(writes(fake.ghCalls)).toEqual([])
  })

  it('refuses a merged PR that does not declare it closes this issue', async () => {
    const { fake, run } = await pluginWith(
      ghFor({ ...MERGED_FIXING_5, closingIssuesReferences: [{ number: 7 }] }),
    )

    await expect(run('issue.close', { projectId: 'p1', number: 5, pr: 12 })).rejects.toMatchObject({
      code: 'pr-not-linked',
    })
    expect(writes(fake.ghCalls)).toEqual([])
  })

  it('comments the evidence, closes the issue and marks the task done', async () => {
    const { fake, run } = await pluginWith(ghFor(MERGED_FIXING_5))

    const result = await run('issue.close', {
      projectId: 'p1',
      number: 5,
      pr: 12,
      evidence: 'all tests green',
    })

    const comment = fake.ghCalls.find(args => args[0] === 'issue' && args[1] === 'comment')
    expect(comment).toEqual(['issue', 'comment', '5', '--body', expect.stringContaining(PR_URL)])
    expect(comment?.[4]).toContain('Evidence: all tests green')
    expect(fake.ghCalls).toContainEqual(['issue', 'close', '5'])
    expect(fake.nodes.get('task-1')?.data.status).toBe('done')
    expect(fake.nodes.get('task-1')?.data.requirement).toBe('Work on it')
    expect(result).toEqual({
      repo: 'C0reca/opencove',
      number: 5,
      pr: 12,
      prUrl: PR_URL,
      taskNodeId: 'task-1',
      closed: true,
    })
  })

  it('treats evidence as one argument, never as shell text', async () => {
    const { fake, run } = await pluginWith(ghFor(MERGED_FIXING_5))

    await run('issue.close', { projectId: 'p1', number: 5, pr: 12, evidence: '$(rm -rf ~); `id`' })

    const comment = fake.ghCalls.find(args => args[1] === 'comment') ?? []
    expect(comment.filter(value => value.includes('rm -rf'))).toHaveLength(1)
  })

  it.each([0, -1, 1.5, '12'])('rejects pr %s before any gh call', async pr => {
    const { fake, run } = await pluginWith(ghFor(MERGED_FIXING_5))

    await expect(run('issue.close', { projectId: 'p1', number: 5, pr })).rejects.toMatchObject({
      code: 'invalid-params',
    })
    expect(fake.ghCalls).toEqual([])
  })

  it('rejects an invalid issue number before any gh call', async () => {
    const { fake, run } = await pluginWith(ghFor(MERGED_FIXING_5))

    await expect(run('issue.close', { projectId: 'p1', number: 0, pr: 12 })).rejects.toMatchObject({
      code: 'invalid-params',
    })
    expect(fake.ghCalls).toEqual([])
  })
})

describe('github-issues issue.request-review', () => {
  it('creates the label idempotently, comments and never closes', async () => {
    const { fake, run } = await pluginWith(ghFor(MERGED_FIXING_5))
    const params = { projectId: 'p1', number: 5, summary: 'Fixed', evidence: 'PR #12 open' }

    await run('issue.request-review', params)
    const second = await run('issue.request-review', params)

    const labelCreates = fake.ghCalls.filter(args => args[0] === 'label')
    expect(labelCreates).toHaveLength(2)
    expect(labelCreates[0]).toEqual(expect.arrayContaining(['create', 'needs-review', '--force']))
    expect(fake.ghCalls.filter(args => args[1] === 'edit')).toHaveLength(2)
    expect(fake.ghCalls.some(args => args[1] === 'close')).toBe(false)
    expect(second).toEqual({
      repo: 'C0reca/opencove',
      number: 5,
      label: 'needs-review',
      closed: false,
    })
  })

  it('requires a summary and evidence', async () => {
    const { fake, run } = await pluginWith(ghFor(MERGED_FIXING_5))

    await expect(
      run('issue.request-review', { projectId: 'p1', number: 5, summary: ' ', evidence: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid-params' })
    expect(fake.ghCalls).toEqual([])
  })
})

describe('github-issues issue.close-manual', () => {
  it('rejects a CLI call with no host context and changes nothing', async () => {
    const { fake, run } = await pluginWith(ghFor(MERGED_FIXING_5))

    await expect(
      run('issue.close-manual', { projectId: 'p1', number: 5, reason: 'duplicate' }, null),
    ).rejects.toMatchObject({ code: 'human-only' })
    await expect(
      run(
        'issue.close-manual',
        { projectId: 'p1', number: 5, reason: 'duplicate' },
        {
          pluginId: 'github-issues',
        },
      ),
    ).rejects.toMatchObject({ code: 'human-only' })
    expect(fake.ghCalls).toEqual([])
  })

  it('closes with the reason recorded when a menu invocation supplies host context', async () => {
    const { fake, run } = await pluginWith(ghFor(MERGED_FIXING_5))

    const result = await run(
      'issue.close-manual',
      { projectId: 'p1', number: 5, reason: 'duplicate of #7' },
      { pluginId: 'github-issues', host: { surface: 'sidebar', projectId: 'p1' } },
    )

    expect(fake.ghCalls).toContainEqual([
      'issue',
      'comment',
      '5',
      '--body',
      'Closed by a human without a pull request. Reason: duplicate of #7',
    ])
    expect(fake.ghCalls).toContainEqual(['issue', 'close', '5'])
    expect(result).toMatchObject({ closed: true, pr: null, taskNodeId: 'task-1' })
  })
})
