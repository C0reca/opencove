import { describe, expect, it } from 'vitest'
import { activate } from '../../../plugins/github-issues/main.mjs'
import { sidebarItemsForProject } from '../../../plugins/github-issues/lib/report.mjs'
import { createFakeHost, failed, ok, remotes, type GhReply } from './githubIssuesFakeHost'

const report = {
  repos: [
    {
      repo: 'C0reca/opencove',
      projectIds: ['p1'],
      issues: [
        {
          number: 1,
          title: 'Mine',
          url: '',
          labels: ['bug'],
          assignees: [],
          author: 'C0reca',
          updatedAt: null,
        },
        {
          number: 2,
          title: 'Theirs',
          url: '',
          labels: [],
          assignees: [],
          author: 'mallory',
          updatedAt: null,
        },
      ],
    },
  ],
  errors: [],
}

const trustedOnly = (author: string | null) => author === 'C0reca'

describe('github-issues sidebar shaping', () => {
  it('gives trusted issues the plain assign command and untrusted ones the labelled menu action', () => {
    const { items } = sidebarItemsForProject(report, 'p1', { isTrusted: trustedOnly })

    expect(items[0]).toEqual({
      id: 'issue-1',
      label: '#1 Mine',
      description: 'bug',
      command: { id: 'issue.assign', params: { projectId: 'p1', number: 1 } },
    })
    expect(items[1]).toEqual({
      id: 'issue-2',
      label: '#2 Theirs',
      description: '⚠ untrusted author: mallory',
      command: { id: 'issue.assign-untrusted', params: { projectId: 'p1', number: 2 } },
    })
    expect(items[items.length - 1]).toMatchObject({ id: 'refresh' })
  })

  it('shows the permission mode first only when it is not normal', () => {
    const auto = sidebarItemsForProject(report, 'p1', {
      isTrusted: trustedOnly,
      permissionMode: 'auto',
    })
    const full = sidebarItemsForProject(report, 'p1', {
      isTrusted: trustedOnly,
      permissionMode: 'full',
    })
    const normal = sidebarItemsForProject(report, 'p1', {
      isTrusted: trustedOnly,
      permissionMode: 'normal',
    })

    expect(auto.items[0]).toEqual({
      id: 'permission-mode-warning',
      label: '⚠ Agents run in auto mode',
    })
    expect(full.items[0]).toEqual({
      id: 'permission-mode-warning',
      label: '⚠ Agents run in full access',
    })
    expect(normal.items[0]).toMatchObject({ id: 'issue-1' })
  })

  it('marks no-agent issues as excluded but keeps them listed', () => {
    const labelled = {
      ...report,
      repos: [
        {
          ...report.repos[0],
          issues: [{ number: 9, title: 'Manual', labels: ['no-agent'], author: 'C0reca', url: '' }],
        },
      ],
    }

    const { items } = sidebarItemsForProject(labelled, 'p1', { isTrusted: () => true })

    expect(items[0]).toMatchObject({
      id: 'issue-9',
      command: { id: 'issue.assign', params: { projectId: 'p1', number: 9 } },
    })
    expect(items[0].description).toContain('excluded from agents (no-agent)')
  })

  it('treats every issue as untrusted when no trust decision is supplied', () => {
    const { items } = sidebarItemsForProject(report, 'p1')

    expect(items.filter(item => item.id.startsWith('issue-')).map(item => item.command.id)).toEqual(
      ['issue.assign-untrusted', 'issue.assign-untrusted'],
    )
  })
})

describe('github-issues sidebar through the backend', () => {
  it('reads author trust with gh and shapes the section', async () => {
    const gh = (args: string[]): GhReply => {
      const line = args.join(' ')
      if (line === 'remote -v') {
        return ok(remotes('C0reca/opencove'))
      }
      if (line.startsWith('issue list ')) {
        return ok(
          JSON.stringify([
            { number: 1, title: 'Mine', labels: [], author: { login: 'C0reca' } },
            { number: 2, title: 'Theirs', labels: [], author: { login: 'mallory' } },
          ]),
        )
      }
      if (line === 'api repos/c0reca/opencove/collaborators/mallory/permission') {
        return ok('{"permission":"read"}')
      }
      return failed('unexpected')
    }
    const fake = createFakeHost({ gh, prefs: { 'permission-modes': 'c0reca/opencove: auto' } })
    const plugin = await activate({ host: fake.host, log: () => undefined })

    const section = await plugin.runCommand('issues.sidebar', { projectId: 'p1' }, null)

    expect(section.items[0]).toMatchObject({
      id: 'permission-mode-warning',
      label: '⚠ Agents run in auto mode',
    })
    expect(section.items.find((item: { id: string }) => item.id === 'issue-1')).toMatchObject({
      command: { id: 'issue.assign' },
    })
    expect(section.items.find((item: { id: string }) => item.id === 'issue-2')).toMatchObject({
      command: { id: 'issue.assign-untrusted' },
    })
  })
})
