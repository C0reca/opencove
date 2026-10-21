import { describe, expect, it } from 'vitest'
import { activate } from '../../../plugins/github-issues/main.mjs'
import {
  findChildSpaceId,
  isWorktreeDirectory,
  issueSpaceName,
  normalizeSpaces,
  selectRootSpace,
  slugify,
  SLUG_MAX_CHARS,
} from '../../../plugins/github-issues/lib/worktree.mjs'
import { createFakeHost, failed, ok, type GhReply } from './githubIssuesFakeHost'

const ISSUE_JSON = JSON.stringify({
  number: 5,
  title: 'Login bug',
  body: 'It breaks',
  url: 'https://github.com/C0reca/opencove/issues/5',
  author: { login: 'C0reca' },
})

const space = (
  id: string,
  extra: Partial<{
    parentSpaceId: string | null
    directoryPath: string
    sortOrder: number
    name: string
  }> = {},
) => ({
  id,
  name: extra.name ?? id,
  parentSpaceId: extra.parentSpaceId ?? null,
  directoryPath: extra.directoryPath ?? '/repo',
  sortOrder: extra.sortOrder ?? 0,
})

const WORKTREE_CHILD = space('space-wt', {
  parentSpaceId: 'space-root',
  directoryPath: '/repo/.opencove/worktrees/issue-4-old--abc123',
})

// The CLI answer to `space list --project p1`: a single root plus a worktree Space.
const LIST_ONE_ROOT = [space('space-root', { name: 'Main' }), WORKTREE_CHILD]

const SPACE_CREATED = ok('{"ok":true,"value":{"childSpace":{"id":"space-child"}}}')
const WORKTREE_CREATED = ok('{"ok":true}')

function spaceListReply(list: unknown[]): GhReply {
  return ok(
    JSON.stringify({ ok: true, value: { projectId: 'p1', activeSpaceId: null, spaces: list } }),
  )
}

function gh(args: string[]): GhReply {
  const line = args.join(' ')
  if (line === 'repo view --json nameWithOwner') {
    return ok('{"nameWithOwner":"C0reca/opencove"}')
  }
  if (line.startsWith('issue view 5 ')) {
    return ok(ISSUE_JSON)
  }
  return failed('unexpected gh call')
}

// Answers `opencove` calls by subcommand. Each reply can be overridden per test.
function cli(
  options: {
    list?: GhReply
    create?: GhReply
    worktree?: GhReply
  } = {},
) {
  return (args: string[]): GhReply => {
    if (args[0] === 'space' && args[1] === 'list') {
      return options.list ?? spaceListReply(LIST_ONE_ROOT)
    }
    if (args[0] === 'space') {
      return options.create ?? SPACE_CREATED
    }
    return options.worktree ?? WORKTREE_CREATED
  }
}

async function assignWith(
  options: {
    cli?: ReturnType<typeof cli>
    prefs?: Record<string, string>
    launchError?: string
  },
  params: Record<string, unknown>,
) {
  const router = options.cli ?? cli()
  const fake = createFakeHost({
    gh: (args: string[], command = 'gh') => (command === 'opencove' ? router(args) : gh(args)),
    prefs: options.prefs,
    launchError: options.launchError,
  })
  const plugin = await activate({ host: fake.host, log: () => undefined })
  const run = () =>
    plugin.runCommand('issue.assign', { projectId: 'p1', number: 5, ...params }, null)
  return { fake, run }
}

describe('github-issues worktree naming', () => {
  it('reduces a title to lowercase ASCII letters, digits and single hyphens', () => {
    expect(slugify('Fix: Login <script>alert(1)</script> & "quotes"!!')).toBe(
      'fix-login-script-alert-1-script-quotes',
    )
    expect(issueSpaceName(12, 'Fix Foo')).toBe('issue-12-fix-foo')
  })

  it('neutralises injection-like titles and never leaves shell or path characters', () => {
    const name = issueSpaceName(7, '$(rm -rf ~); `id` ../../etc/passwd && curl x|sh')

    expect(name).toMatch(/^[a-z0-9-]+$/)
    expect(name).not.toMatch(/--|^-|-$/)
    expect(name.startsWith('issue-7-rm-rf')).toBe(true)
  })

  it('caps the slug length and drops a trailing hyphen', () => {
    const slug = slugify(`${'word '.repeat(30)}end`)

    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_CHARS)
    expect(slug.endsWith('-')).toBe(false)
  })

  it('falls back to the number alone when the title has no ASCII letters', () => {
    expect(issueSpaceName(9, 'データ 修正')).toBe('issue-9')
  })

  it('finds the child Space id in any envelope', () => {
    expect(findChildSpaceId({ childSpace: { id: 'a' } })).toBe('a')
    expect(findChildSpaceId({ ok: true, value: { childSpace: { id: 'b' } } })).toBe('b')
    expect(findChildSpaceId({ ok: true })).toBeNull()
  })
})

// The error code thrown by fn, or null when it does not throw.
function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? null
  }
}

describe('github-issues root Space rule', () => {
  it('recognises worktree directories under .opencove/worktrees on both separators', () => {
    expect(isWorktreeDirectory('/repo/.opencove/worktrees/issue-4--abc')).toBe(true)
    expect(isWorktreeDirectory('C:\\repo\\.opencove\\worktrees\\issue-4--abc')).toBe(true)
    expect(isWorktreeDirectory('/repo')).toBe(false)
    expect(isWorktreeDirectory('/repo/.opencove/other')).toBe(false)
  })

  it('picks the single root and excludes worktree Spaces', () => {
    const spaces = normalizeSpaces(LIST_ONE_ROOT)

    expect(selectRootSpace(spaces)).toBe('space-root')
  })

  it('fails with no-root-space when every Space is a child or a worktree', () => {
    const spaces = normalizeSpaces([WORKTREE_CHILD, space('space-child', { parentSpaceId: 'x' })])

    expect(codeOf(() => selectRootSpace(spaces))).toBe('no-root-space')
  })

  it('fails with ambiguous-root-space and lists the candidates lowest sortOrder first', () => {
    const spaces = normalizeSpaces([
      space('space-b', { name: 'Second', sortOrder: 2 }),
      space('space-a', { name: 'First', sortOrder: 1 }),
    ])

    let caught: unknown = null
    try {
      selectRootSpace(spaces)
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({
      code: 'ambiguous-root-space',
      details: {
        candidates: [
          { id: 'space-a', name: 'First' },
          { id: 'space-b', name: 'Second' },
        ],
      },
    })
  })

  it('takes an explicit parentSpaceId over the rule, even when the rule is ambiguous', () => {
    const spaces = normalizeSpaces([space('space-a'), space('space-b')])

    expect(selectRootSpace(spaces, { explicitParentSpaceId: 'space-b' })).toBe('space-b')
  })

  it('rejects an explicit parent that is not a Space of the project', () => {
    const spaces = normalizeSpaces(LIST_ONE_ROOT)

    expect(codeOf(() => selectRootSpace(spaces, { explicitParentSpaceId: 'space-foreign' }))).toBe(
      'parent-not-in-project',
    )
  })
})

describe('github-issues issue.assign with worktree', () => {
  it('lists the project Spaces, then creates the child Space and the worktree, with exact argument lists', async () => {
    const { fake, run } = await assignWith({}, { worktree: true })

    await run()

    expect(fake.processCalls).toEqual([
      { command: 'opencove', args: ['space', 'list', '--project', 'p1'] },
      {
        command: 'opencove',
        args: [
          'space',
          'create',
          '--parent',
          'space-root',
          '--name',
          'issue-5-login-bug',
          '--project',
          'p1',
        ],
      },
      {
        command: 'opencove',
        args: ['worktree', 'create', '--space', 'space-child', '--name', 'issue-5-login-bug'],
      },
    ])
  })

  it('creates the task and launches the agent in the child Space, with taskNodeId', async () => {
    const { fake, run } = await assignWith({}, { worktree: true })

    const result = await run()

    expect(fake.created[0].spaceId).toBe('space-child')
    expect(fake.launches[0]).toMatchObject({
      target: { projectId: 'p1', spaceId: 'space-child' },
      taskNodeId: fake.created[0].id,
      agentFullAccess: false,
    })
    expect(result).toMatchObject({ spaceId: 'space-child', branch: 'issue-5-login-bug' })
  })

  it('creates under the explicit parentSpaceId when one is given', async () => {
    const list = [space('space-a', { name: 'A' }), space('space-b', { name: 'B' })]
    const { fake, run } = await assignWith(
      { cli: cli({ list: spaceListReply(list) }) },
      { worktree: true, parentSpaceId: 'space-b' },
    )

    await run()

    expect(fake.processCalls[1].args).toEqual(expect.arrayContaining(['--parent', 'space-b']))
  })

  it('refuses an ambiguous root without creating anything', async () => {
    const list = [space('space-a', { name: 'A' }), space('space-b', { name: 'B', sortOrder: 1 })]
    const { fake, run } = await assignWith(
      { cli: cli({ list: spaceListReply(list) }) },
      { worktree: true },
    )

    await expect(run()).rejects.toMatchObject({
      code: 'ambiguous-root-space',
      details: {
        candidates: [
          { id: 'space-a', name: 'A' },
          { id: 'space-b', name: 'B' },
        ],
      },
    })
    expect(fake.processCalls.map(call => call.args[0])).toEqual(['space'])
    expect(fake.processCalls[0].args[1]).toBe('list')
    expect(fake.created).toHaveLength(0)
  })

  it('refuses a foreign parentSpaceId without creating anything', async () => {
    const { fake, run } = await assignWith({}, { worktree: true, parentSpaceId: 'space-foreign' })

    await expect(run()).rejects.toMatchObject({ code: 'parent-not-in-project' })
    expect(fake.processCalls.some(call => call.args[1] === 'create')).toBe(false)
    expect(fake.created).toHaveLength(0)
  })

  it('refuses a project with no root Space', async () => {
    const { fake, run } = await assignWith(
      { cli: cli({ list: spaceListReply([WORKTREE_CHILD]) }) },
      { worktree: true },
    )

    await expect(run()).rejects.toMatchObject({ code: 'no-root-space' })
    expect(fake.processCalls.some(call => call.args[1] === 'create')).toBe(false)
  })

  it('rejects a missing opencove CLI with cli-missing and creates nothing', async () => {
    const { fake, run } = await assignWith(
      { cli: () => ({ status: 'failed', error: 'spawn opencove ENOENT' }) },
      { worktree: true },
    )

    await expect(run()).rejects.toMatchObject({ code: 'cli-missing' })
    expect(fake.created).toHaveLength(0)
    expect(fake.launches).toHaveLength(0)
  })

  it('reports parent_missing_rect with the human action', async () => {
    const { fake, run } = await assignWith(
      {
        cli: args =>
          args[1] === 'create'
            ? {
                status: 'completed',
                exitCode: 1,
                output: '{"ok":false,"error":{"debugMessage":"parent_missing_rect"}}',
              }
            : cli()(args),
      },
      { worktree: true },
    )

    await expect(run()).rejects.toMatchObject({
      code: 'parent_missing_rect',
      message: expect.stringContaining('place the root Space'),
    })
    expect(fake.created).toHaveLength(0)
  })

  it('reports a branch collision and the Space it left behind', async () => {
    const { fake, run } = await assignWith(
      {
        cli: args =>
          args[0] === 'worktree'
            ? {
                status: 'completed',
                exitCode: 1,
                output: "fatal: a branch named 'issue-5-login-bug' already exists",
              }
            : cli()(args),
      },
      { worktree: true },
    )

    await expect(run()).rejects.toMatchObject({
      code: 'branch-exists',
      details: { spaceId: 'space-child', branch: 'issue-5-login-bug' },
    })
    expect(fake.created).toHaveLength(0)
  })

  it('reports a partial failure with the created Space and branch, and deletes nothing', async () => {
    const { fake, run } = await assignWith(
      { launchError: 'agent host unavailable' },
      { worktree: true },
    )

    await expect(run()).rejects.toMatchObject({
      message: expect.stringContaining('space-child'),
      details: { spaceId: 'space-child', branch: 'issue-5-login-bug' },
    })
    expect(fake.processCalls.map(call => call.args[0])).toEqual(['space', 'space', 'worktree'])
    expect(fake.processCalls.some(call => call.args.includes('archive'))).toBe(false)
  })

  it('reuses an existing task without a second Space or worktree', async () => {
    const { fake, run } = await assignWith({}, { worktree: true })
    fake.nodes.set('task-old', {
      id: 'task-old',
      kind: 'task',
      title: '#5 Login bug',
      spaceId: 'space-old',
      data: {
        kind: 'task',
        tags: ['issue:c0reca/opencove#5'],
        status: 'doing',
        linkedAgentNodeId: 'agent-old',
      },
    })

    const result = await run()

    expect(fake.processCalls).toEqual([])
    expect(fake.launches).toHaveLength(0)
    expect(result).toMatchObject({ taskNodeId: 'task-old', reused: true, agentNodeId: 'agent-old' })
  })

  it('relaunches a todo task inside its own Space, not a new one', async () => {
    const { fake, run } = await assignWith({}, { worktree: true })
    fake.nodes.set('task-todo', {
      id: 'task-todo',
      kind: 'task',
      title: '#5 Login bug',
      spaceId: 'space-old',
      data: { kind: 'task', tags: ['issue:c0reca/opencove#5'], status: 'todo' },
    })

    await run()

    expect(fake.processCalls).toEqual([])
    expect(fake.launches[0]).toMatchObject({
      target: { projectId: 'p1', spaceId: 'space-old' },
      taskNodeId: 'task-todo',
    })
  })

  it('uses the worktree-repos preference by default, and an explicit false wins', async () => {
    const preferred = await assignWith({ prefs: { 'worktree-repos': 'C0reca/OpenCove' } }, {})
    await preferred.run()
    expect(preferred.fake.processCalls.some(call => call.args[1] === 'create')).toBe(true)

    const explicit = await assignWith(
      { prefs: { 'worktree-repos': 'c0reca/opencove' } },
      { worktree: false },
    )
    await explicit.run()
    expect(explicit.fake.processCalls).toEqual([])
    expect(explicit.fake.created[0].spaceId).toBeNull()
  })

  it('keeps the plain behaviour when worktree is not set and the repo is not listed', async () => {
    const { fake, run } = await assignWith({}, {})

    await run()

    expect(fake.processCalls).toEqual([])
    expect(fake.launches[0].target).toEqual({ projectId: 'p1' })
  })

  it('rejects a non-boolean worktree value before any call', async () => {
    const { fake, run } = await assignWith({}, { worktree: 'yes' })

    await expect(run()).rejects.toMatchObject({ code: 'invalid-params' })
    expect(fake.processCalls).toEqual([])
  })
})
