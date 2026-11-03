import { describe, expect, it } from 'vitest'
import { activate } from '../../../plugins/github-issues/main.mjs'
import { createFakeHost, failed, ok, remotes, type FakeNode } from './githubIssuesFakeHost'

const URL_7 = 'https://github.com/C0reca/opencove/issues/7'

const note = (text: string): FakeNode => ({
  id: 'note-1',
  kind: 'note',
  title: 'Note',
  data: { kind: 'note', text } as FakeNode['data'],
})

const task = (requirement: string, tags: string[] = []): FakeNode => ({
  id: 'task-1',
  kind: 'task',
  title: 'Task',
  data: { kind: 'task', requirement, tags, status: 'todo' },
})

const menu = (nodeIds: string[]) => ({
  pluginId: 'github-issues',
  host: { surface: 'node', projectId: 'p1', nodeIds },
})

async function harness(nodes: FakeNode[], createReply = ok(`Creating issue\n${URL_7}\n`)) {
  const fake = createFakeHost({
    nodes,
    gh: args => {
      const line = args.join(' ')
      if (line === 'remote -v') {
        return ok(remotes('C0reca/opencove'))
      }
      if (line.startsWith('issue create ')) {
        return createReply
      }
      return failed('unexpected gh call')
    },
  })
  const plugin = await activate({ host: fake.host, log: () => undefined })
  const run = (context: unknown) => plugin.runCommand('issue.create-from-node', null, context)
  const creates = () => fake.ghCalls.filter(args => args[0] === 'issue' && args[1] === 'create')
  return { fake, plugin, run, creates }
}

describe('github-issues issue.create-from-node', () => {
  it('creates an issue from a note (first line = title) and appends the link to the note', async () => {
    const h = await harness([note('Fix the login\n\nSteps:\n1. open; rm -rf /')])
    const result = await h.run(menu(['note-1']))
    expect(result).toEqual({ created: true, number: 7, url: URL_7, nodeId: 'note-1' })
    expect(h.creates()).toEqual([
      ['issue', 'create', '--title', 'Fix the login', '--body', 'Steps:\n1. open; rm -rf /'],
    ])
    expect(h.fake.rawGhCalls.find(call => call.args[1] === 'create')?.repo).toBe('C0reca/opencove')
    expect(h.fake.nodes.get('note-1')?.data).toMatchObject({
      text: `Fix the login\n\nSteps:\n1. open; rm -rf /\n\nIssue: ${URL_7}`,
    })
    await h.plugin.dispose()
  })

  it('tags a task with created-issue and keeps its other fields', async () => {
    const h = await harness([task('Add dark mode', ['ui'])])
    await h.run(menu(['task-1']))
    expect(h.creates()[0]).toEqual(['issue', 'create', '--title', 'Add dark mode', '--body', ''])
    expect(h.fake.nodes.get('task-1')?.data).toMatchObject({
      requirement: 'Add dark mode',
      status: 'todo',
      tags: ['ui', 'created-issue:C0reca/opencove#7'],
    })
    await h.plugin.dispose()
  })

  it('creates at most one issue per node (idempotent by the existing link)', async () => {
    const h = await harness([note('Fix the login'), task('Dark mode')])
    await h.run(menu(['note-1']))
    await h.run(menu(['task-1']))
    expect(await h.run(menu(['note-1']))).toEqual({
      created: false,
      number: 7,
      url: URL_7,
      nodeId: 'note-1',
    })
    expect(await h.run(menu(['task-1']))).toMatchObject({ created: false, number: 7 })
    expect(h.creates()).toHaveLength(2)
    await h.plugin.dispose()
  })

  it('does not treat another issue URL in the note text as its link', async () => {
    const h = await harness([note('Follow-up\nSee https://github.com/C0reca/opencove/issues/3')])
    expect(await h.run(menu(['note-1']))).toMatchObject({ created: true, number: 7 })
    await h.plugin.dispose()
  })

  it('refuses a second click while the first creation is still running', async () => {
    const h = await harness([note('Fix the login')])
    const [first, second] = await Promise.allSettled([
      h.run(menu(['note-1'])),
      h.run(menu(['note-1'])),
    ])
    expect(first.status).toBe('fulfilled')
    expect(second).toMatchObject({ status: 'rejected', reason: { code: 'in-progress' } })
    expect(h.creates()).toHaveLength(1)
    await h.plugin.dispose()
  })

  it('refuses CLI runs, empty text, other node kinds and several nodes', async () => {
    const h = await harness([
      note('   \n  '),
      { id: 'web-1', kind: 'website', title: 'Site', data: { kind: 'website' } },
      task('A'),
    ])
    await expect(h.run(null)).rejects.toMatchObject({ code: 'human-only' })
    await expect(h.run(menu(['note-1']))).rejects.toMatchObject({ code: 'empty-text' })
    await expect(h.run(menu(['web-1']))).rejects.toMatchObject({ code: 'invalid-node' })
    await expect(h.run(menu(['note-1', 'task-1']))).rejects.toMatchObject({ code: 'invalid-node' })
    expect(h.creates()).toEqual([])
    await h.plugin.dispose()
  })

  it('leaves the node untouched when gh fails', async () => {
    const h = await harness([note('Fix the login')], failed('HTTP 403'))
    await expect(h.run(menu(['note-1']))).rejects.toBeTruthy()
    expect(h.fake.updates).toEqual([])
    await h.plugin.dispose()
  })
})
