import { describe, expect, it } from 'vitest'
import {
  classifyGhFailure,
  extractJson,
  issueListArgs,
  parseIssueList,
  parseRepoView,
} from '../../../plugins/github-issues/lib/gh.mjs'
import { createTtlCache } from '../../../plugins/github-issues/lib/cache.mjs'
import {
  buildReport,
  groupLookupsByRepo,
  sidebarItemsForProject,
} from '../../../plugins/github-issues/lib/report.mjs'

describe('github-issues gh parsing', () => {
  it('builds an array-based issue list command with the documented fields', () => {
    expect(issueListArgs()).toEqual([
      'issue',
      'list',
      '--state',
      'open',
      '--limit',
      '50',
      '--json',
      'number,title,url,labels,assignees,author,updatedAt',
    ])
  })

  it('normalises issues and drops entries without a number', () => {
    const text = JSON.stringify([
      {
        number: 7,
        title: 'Fix login',
        url: 'https://github.com/o/r/issues/7',
        labels: [{ name: 'bug' }, { name: '' }, {}],
        assignees: [{ login: 'alice' }],
        author: { login: 'bob' },
        updatedAt: '2026-10-20T10:00:00Z',
      },
      { title: 'no number' },
      null,
    ])

    expect(parseIssueList(text)).toEqual([
      {
        number: 7,
        title: 'Fix login',
        url: 'https://github.com/o/r/issues/7',
        labels: ['bug'],
        assignees: ['alice'],
        author: 'bob',
        updatedAt: '2026-10-20T10:00:00Z',
      },
    ])
  })

  it('rejects output that is not an issue array', () => {
    expect(() => parseIssueList('{"number":1}')).toThrow(/array/)
    expect(() => parseIssueList('not json')).toThrow()
  })

  it('skips gh warning lines printed before the JSON payload', () => {
    const text = 'warning: something\n[{"number":3,"title":"t"}]'
    expect(extractJson(text)).toEqual([{ number: 3, title: 't' }])
  })

  it('parses owner/name from gh repo view and rejects malformed values', () => {
    expect(parseRepoView('{"nameWithOwner":"C0reca/opencove"}')).toBe('C0reca/opencove')
    expect(() => parseRepoView('{"nameWithOwner":"just-a-name"}')).toThrow()
    expect(() => parseRepoView('{}')).toThrow()
  })

  it('classifies missing gh, missing auth and non-GitHub projects', () => {
    expect(classifyGhFailure({ status: 'failed', error: 'spawn gh ENOENT' }).code).toBe(
      'gh-missing',
    )
    expect(
      classifyGhFailure({
        status: 'completed',
        exitCode: 4,
        output: 'To get started with GitHub CLI, please run:  gh auth login',
      }).code,
    ).toBe('gh-unauthenticated')
    expect(
      classifyGhFailure({
        status: 'completed',
        exitCode: 1,
        output: 'could not determine current repository: no git remotes found',
      }).code,
    ).toBe('not-github')
  })

  it('keeps unknown gh failures as bounded text', () => {
    const failure = classifyGhFailure({
      status: 'completed',
      exitCode: 2,
      output: `boom ${'x'.repeat(400)}`,
    })
    expect(failure.code).toBe('gh-failed')
    expect(failure.message.startsWith('gh failed (exit 2): boom')).toBe(true)
    expect(failure.message.length).toBeLessThanOrEqual(300)
  })
})

describe('github-issues cache', () => {
  it('returns cached values until the TTL elapses', () => {
    let clock = 1_000
    const cache = createTtlCache({ ttlMs: 60_000, now: () => clock })
    cache.set('repo', ['a'])

    clock += 59_999
    expect(cache.get('repo')).toEqual(['a'])

    clock += 1
    expect(cache.get('repo')).toBeUndefined()
  })
})

describe('github-issues grouping and sidebar items', () => {
  const issue = {
    number: 1,
    title: 'First',
    url: '',
    labels: ['bug', 'p1'],
    assignees: [],
    author: null,
    updatedAt: null,
  }

  it('dedupes projects that share a repository and keeps failing projects as errors', () => {
    const groups = groupLookupsByRepo([
      { projectId: 'p1', repo: 'C0reca/opencove', error: null },
      { projectId: 'p2', repo: 'C0reca/opencove', error: null },
      { projectId: 'p3', repo: null, error: { code: 'not-github', message: 'nope' } },
    ])
    expect(groups.repos).toEqual([{ repo: 'C0reca/opencove', projectIds: ['p1', 'p2'] }])
    expect(groups.errors).toEqual([
      { projectIds: ['p3'], repo: null, code: 'not-github', message: 'nope' },
    ])

    const report = buildReport(
      groups,
      new Map([['C0reca/opencove', { ok: true, issues: [issue] }]]),
    )
    expect(report.repos[0]).toEqual({
      repo: 'C0reca/opencove',
      projectIds: ['p1', 'p2'],
      issues: [issue],
    })
    expect(report.errors).toHaveLength(1)
  })

  it('reports a failing repository without dropping the other repositories', () => {
    const groups = groupLookupsByRepo([
      { projectId: 'a', repo: 'o/one', error: null },
      { projectId: 'b', repo: 'o/two', error: null },
    ])
    const report = buildReport(
      groups,
      new Map([
        ['o/one', { ok: false, error: { code: 'gh-unauthenticated', message: 'login' } }],
        ['o/two', { ok: true, issues: [] }],
      ]),
    )
    expect(report.repos.map(repo => repo.repo)).toEqual(['o/two'])
    expect(report.errors).toEqual([
      { projectIds: ['a'], repo: 'o/one', code: 'gh-unauthenticated', message: 'login' },
    ])
  })

  it('renders issue items with number, title and labels, plus a refresh action', () => {
    const report = buildReport(
      groupLookupsByRepo([{ projectId: 'p1', repo: 'o/one', error: null }]),
      new Map([['o/one', { ok: true, issues: [issue] }]]),
    )
    expect(sidebarItemsForProject(report, 'p1', { isTrusted: () => true })).toEqual({
      items: [
        {
          id: 'issue-1',
          label: '#1 First',
          description: 'bug, p1',
          command: { id: 'issue.assign', params: { projectId: 'p1', number: 1 } },
        },
        {
          id: 'refresh',
          label: 'Refresh issues',
          command: { id: 'issues.refresh', params: { projectId: 'p1' } },
        },
      ],
    })
  })

  it('shows the error for a project that has no GitHub repository', () => {
    const report = buildReport(
      groupLookupsByRepo([
        { projectId: 'p9', repo: null, error: { code: 'not-github', message: 'Not GitHub' } },
      ]),
      new Map(),
    )
    const tree = sidebarItemsForProject(report, 'p9')
    expect(tree.items[0]).toEqual({ id: 'status', label: 'Not GitHub', description: 'not-github' })
  })
})
