import { describe, expect, it } from 'vitest'
import { activate } from '../../../plugins/github-issues/main.mjs'
import { effectiveModeFor } from '../../../plugins/github-issues/lib/locality.mjs'
import { sidebarItemsForProject } from '../../../plugins/github-issues/lib/report.mjs'
import {
  createFakeHost,
  failed,
  ok,
  remotes,
  type FakeHostOptions,
  type GhReply,
} from './githubIssuesFakeHost'

const ROOT_SPACE = {
  id: 'space-root',
  name: 'Main',
  parentSpaceId: null,
  directoryPath: '/Users/me/repo',
  sortOrder: 0,
}

const ISSUE_JSON = {
  number: 5,
  title: 'Login bug',
  body: '',
  url: 'https://github.com/C0reca/opencove/issues/5',
  author: { login: 'C0reca' },
  labels: [],
}

// Answers every gh, git and opencove call the launch paths make for project p1 (repo C0reca/opencove).
function gh(args: string[], command = 'gh'): GhReply {
  if (command === 'opencove') {
    if (args[0] === 'space' && args[1] === 'list') {
      return ok(JSON.stringify({ ok: true, value: { spaces: [ROOT_SPACE] } }))
    }
    return ok('{"ok":true,"value":{"childSpace":{"id":"space-created"}}}')
  }
  const line = args.join(' ')
  if (line === 'remote -v') {
    return ok(remotes('C0reca/opencove'))
  }
  if (line.startsWith('issue view 5 ')) {
    return ok(JSON.stringify(ISSUE_JSON))
  }
  if (line.startsWith('issue list ')) {
    return ok(JSON.stringify([{ ...ISSUE_JSON, updatedAt: null, assignees: [] }]))
  }
  return failed('unused')
}

const hostWith = (locality: FakeHostOptions['locality'], prefs: Record<string, string> = {}) =>
  createFakeHost({ gh, locality, prefs, spaces: [] })

const REPORT = {
  repos: [
    {
      repo: 'C0reca/opencove',
      projectIds: ['p1'],
      issues: [
        {
          number: 1,
          title: 'Mine',
          url: '',
          labels: [],
          assignees: [],
          author: 'C0reca',
          updatedAt: null,
        },
      ],
    },
  ],
  errors: [],
}

describe('github-issues effective permission mode (local-only autonomy)', () => {
  it.each(['auto', 'full'] as const)('keeps %s on a local target', async mode => {
    const fake = hostWith('local')
    expect(await effectiveModeFor(fake.host, { projectId: 'p1' }, mode)).toEqual({
      configuredMode: mode,
      effectiveMode: mode,
      reason: null,
    })
  })

  it.each(['auto', 'full'] as const)(
    'falls back to normal for %s on a remote target, with the remote-target reason',
    async mode => {
      const fake = hostWith('remote')
      expect(await effectiveModeFor(fake.host, { projectId: 'p1' }, mode)).toEqual({
        configuredMode: mode,
        effectiveMode: 'normal',
        reason: 'remote-target',
      })
    },
  )

  it.each(['local', 'remote', 'unknown', 'throws'] as const)(
    'leaves normal unchanged on a %s target and does not resolve it',
    async locality => {
      const fake = hostWith(locality)
      expect(await effectiveModeFor(fake.host, { projectId: 'p1' }, 'normal')).toEqual({
        configuredMode: 'normal',
        effectiveMode: 'normal',
        reason: null,
      })
      expect(fake.resolves).toEqual([])
    },
  )

  it.each(['unknown', 'throws'] as const)(
    'fails closed when the locality cannot be determined (%s)',
    async locality => {
      const fake = hostWith(locality)
      expect(await effectiveModeFor(fake.host, { projectId: 'p1' }, 'full')).toEqual({
        configuredMode: 'full',
        effectiveMode: 'normal',
        reason: 'unknown-target',
      })
    },
  )

  it('resolves the launched target once, with the projectId and spaceId given', async () => {
    const fake = hostWith('local')
    await effectiveModeFor(fake.host, { projectId: 'p1', spaceId: 'space-1' }, 'auto')
    expect(fake.resolves).toEqual([{ projectId: 'p1', spaceId: 'space-1' }])
  })
})

describe('github-issues launches on a remote project', () => {
  it('runs the coordinator in normal and returns the decision', async () => {
    const fake = hostWith('remote', { 'permission-modes': 'c0reca/opencove: full' })
    const plugin = await activate({ host: fake.host, log: () => undefined })

    const result = await plugin.runCommand('coordinator.launch', { projectId: 'p1' }, null)

    expect(fake.launches[0]).toMatchObject({ agentPermissionMode: 'default' })
    expect(result).toMatchObject({
      configuredMode: 'full',
      effectiveMode: 'normal',
      reason: 'remote-target',
      agentPermissionMode: 'default',
    })
  })

  it('keeps the coordinator on auto for a local project', async () => {
    const fake = hostWith('local', { 'permission-modes': 'c0reca/opencove: auto' })
    const plugin = await activate({ host: fake.host, log: () => undefined })

    const result = await plugin.runCommand('coordinator.launch', { projectId: 'p1' }, null)

    expect(fake.launches[0]).toMatchObject({ agentPermissionMode: 'auto' })
    expect(result).toMatchObject({
      configuredMode: 'auto',
      effectiveMode: 'auto',
      reason: null,
      agentPermissionMode: 'auto',
    })
  })

  it('runs an issue agent in normal on a remote project and returns the decision', async () => {
    const fake = hostWith('remote', { 'permission-modes': 'c0reca/opencove: full' })
    const plugin = await activate({ host: fake.host, log: () => undefined })

    const result = await plugin.runCommand('issue.assign', { projectId: 'p1', number: 5 }, null)

    expect(fake.launches[0]).toMatchObject({ agentPermissionMode: 'default' })
    expect(result).toMatchObject({
      configuredMode: 'full',
      effectiveMode: 'normal',
      reason: 'remote-target',
      agentPermissionMode: 'default',
    })
  })

  it('keeps full for an issue agent on a local project', async () => {
    const fake = hostWith('local', { 'permission-modes': 'c0reca/opencove: full' })
    const plugin = await activate({ host: fake.host, log: () => undefined })

    const result = await plugin.runCommand('issue.assign', { projectId: 'p1', number: 5 }, null)

    expect(fake.launches[0]).toMatchObject({ agentPermissionMode: 'full' })
    expect(result).toMatchObject({
      configuredMode: 'full',
      effectiveMode: 'full',
      reason: null,
      agentPermissionMode: 'full',
    })
  })
})

describe('github-issues sidebar on a remote project', () => {
  it('warns that auto or full is configured but running in normal on a remote project', () => {
    const auto = sidebarItemsForProject(REPORT, 'p1', {
      permissionMode: 'auto',
      fallbackReason: 'remote-target',
    })
    const full = sidebarItemsForProject(REPORT, 'p1', {
      permissionMode: 'full',
      fallbackReason: 'remote-target',
    })

    expect(auto.items[0]).toEqual({
      id: 'permission-mode-warning',
      label: '⚠ auto configured, running in normal: remote project (guard cannot run there)',
    })
    expect(full.items[0]).toEqual({
      id: 'permission-mode-warning',
      label: '⚠ full configured, running in normal: remote project (guard cannot run there)',
    })
  })

  it('says the location is unknown when locality could not be determined', () => {
    const { items } = sidebarItemsForProject(REPORT, 'p1', {
      permissionMode: 'full',
      fallbackReason: 'unknown-target',
    })

    expect(items[0].label).toBe(
      '⚠ full configured, running in normal: project location unknown (guard cannot run there)',
    )
  })

  it('keeps the local auto and full warnings when there is no fallback', () => {
    const { items } = sidebarItemsForProject(REPORT, 'p1', {
      permissionMode: 'full',
      fallbackReason: null,
    })

    expect(items[0].label).toBe('⚠ Agents run in full access')
  })

  it('shows the remote warning through the issues.sidebar command', async () => {
    const fake = hostWith('remote', { 'permission-modes': 'c0reca/opencove: auto' })
    const plugin = await activate({ host: fake.host, log: () => undefined })

    const sidebar = await plugin.runCommand('issues.sidebar', { projectId: 'p1' }, null)

    expect(sidebar.items[0]).toEqual({
      id: 'permission-mode-warning',
      label: '⚠ auto configured, running in normal: remote project (guard cannot run there)',
    })
  })

  it('shows no mode warning for normal on a remote project', async () => {
    const fake = hostWith('remote')
    const plugin = await activate({ host: fake.host, log: () => undefined })

    const sidebar = await plugin.runCommand('issues.sidebar', { projectId: 'p1' }, null)

    expect(sidebar.items[0]).toMatchObject({ id: 'issue-5' })
  })
})
