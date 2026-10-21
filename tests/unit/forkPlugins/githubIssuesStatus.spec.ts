import { describe, expect, it } from 'vitest'
import { activate } from '../../../plugins/github-issues/main.mjs'
import { parseIssueTag } from '../../../plugins/github-issues/lib/tasks.mjs'
import { createFakeHost, failed, type FakeNode } from './githubIssuesFakeHost'

const task = (
  id: string,
  tags: string[],
  status: string,
  extra: { linkedAgentNodeId?: string | null; title?: string } = {},
): FakeNode => ({
  id,
  kind: 'task',
  title: extra.title ?? '#5 Login bug',
  data: {
    kind: 'task',
    tags,
    status,
    requirement: 'R',
    linkedAgentNodeId: extra.linkedAgentNodeId,
  },
})

const agent = (id: string, title: string, status: string, prompt = ''): FakeNode => ({
  id,
  kind: 'agent',
  title,
  status,
  data: { kind: 'agent', prompt },
})

const PROMPT_7 =
  'Work on GitHub issue o/r#7 at https://github.com/o/r/issues/7.\nOpen a pull request...'

async function statusOf(nodes: FakeNode[], agentStates: Record<string, string> = {}) {
  const fake = createFakeHost({ gh: () => failed('unused'), nodes, agentStates })
  const plugin = await activate({ host: fake.host, log: () => undefined })
  return (await plugin.runCommand('agents.status', { projectId: 'p1' }, null)).issues
}

describe('github-issues tag parsing', () => {
  it('reads issue tags and ignores other tags', () => {
    expect(parseIssueTag('issue:C0reca/OpenCove#5')).toEqual({
      repo: 'c0reca/opencove',
      number: 5,
    })
    expect(parseIssueTag('issue:o/r#0')).toBeNull()
    expect(parseIssueTag('bug')).toBeNull()
    expect(parseIssueTag(undefined)).toBeNull()
  })
})

describe('github-issues agents.status', () => {
  it('resolves the agent through the stored link and shapes one row per issue task', async () => {
    const rows = await statusOf(
      [
        task('task-1', ['issue:c0reca/opencove#5'], 'doing', { linkedAgentNodeId: 'agent-new' }),
        task('task-2', ['issue:o/r#9'], 'todo', {
          linkedAgentNodeId: 'agent-b',
          title: '#9 Other',
        }),
        task('task-3', ['chore'], 'doing', { title: 'Not an issue' }),
        agent('agent-old', '#5 Login bug', 'exited', 'Work on GitHub issue C0reca/opencove#5 at x'),
        agent('agent-b', '#9 Other', 'running'),
        agent('agent-new', '#5 Login bug', 'running'),
      ],
      { 'agent-new': 'working', 'agent-b': 'done' },
    )

    expect(rows).toEqual([
      {
        issue: 'c0reca/opencove#5',
        repo: 'c0reca/opencove',
        number: 5,
        projectId: 'p1',
        taskNodeId: 'task-1',
        taskStatus: 'doing',
        agentNodeId: 'agent-new',
        runtimeStatus: 'running',
        agentState: 'working',
      },
      {
        issue: 'o/r#9',
        repo: 'o/r',
        number: 9,
        projectId: 'p1',
        taskNodeId: 'task-2',
        taskStatus: 'todo',
        agentNodeId: 'agent-b',
        runtimeStatus: 'running',
        agentState: 'done',
      },
    ])
  })

  it('prefers the stored link over a prompt that happens to match', async () => {
    const [row] = await statusOf([
      task('task-1', ['issue:o/r#7'], 'doing', { linkedAgentNodeId: 'agent-linked' }),
      agent('agent-stale', 'other', 'exited', PROMPT_7),
      agent('agent-linked', 'other', 'running'),
    ])

    expect(row).toMatchObject({ agentNodeId: 'agent-linked', runtimeStatus: 'running' })
  })

  it('reports a linked agent that is not listed with a null runtime status', async () => {
    const [row] = await statusOf([
      task('task-1', ['issue:o/r#7'], 'doing', { linkedAgentNodeId: 'agent-gone' }),
    ])

    expect(row).toMatchObject({ agentNodeId: 'agent-gone', runtimeStatus: null, agentState: null })
  })

  it('falls back to the legacy prompt match only for tasks without a stored link', async () => {
    // LEGACY path: a task created before core #6 has no linkedAgentNodeId.
    const [row] = await statusOf([
      task('task-1', ['issue:o/r#7'], 'todo'),
      agent('agent-legacy', 'other', 'running', PROMPT_7),
    ])

    expect(row).toMatchObject({ agentNodeId: 'agent-legacy', runtimeStatus: 'running' })
  })

  it('reports null for a task with no agent and for an unknown agent state', async () => {
    const [unknownState] = await statusOf(
      [
        task('task-1', ['issue:o/r#7'], 'doing', { linkedAgentNodeId: 'agent-x' }),
        agent('agent-x', 'x', 'running'),
      ],
      { 'agent-x': 'thinking' },
    )
    expect(unknownState).toMatchObject({ agentNodeId: 'agent-x', agentState: null })

    const [lonely] = await statusOf([
      task('task-2', ['issue:o/r#6'], 'todo', { title: '#6 Lonely' }),
    ])
    expect(lonely).toMatchObject({ agentNodeId: null, runtimeStatus: null, agentState: null })
  })

  it('rejects a non-string projectId', async () => {
    const fake = createFakeHost({ gh: () => failed('unused') })
    const plugin = await activate({ host: fake.host, log: () => undefined })

    await expect(plugin.runCommand('agents.status', { projectId: 5 }, null)).rejects.toThrow(
      /projectId/,
    )
  })
})
