import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { activate } from '../../../plugins/github-issues/main.mjs'
import { MAX_READ_CHARS } from '../../../plugins/github-issues/lib/agentRead.mjs'
import { createFakeHost, failed, type FakeNode } from './githubIssuesFakeHost'

const task = (id: string, tags: string[], linkedAgentNodeId: string | null): FakeNode => ({
  id,
  kind: 'task',
  title: '#7 Thing',
  data: { kind: 'task', tags, status: 'doing', requirement: 'R', linkedAgentNodeId },
})

const agent = (id: string): FakeNode => ({
  id,
  kind: 'agent',
  title: '#7 Thing',
  status: 'running',
  data: { kind: 'agent', prompt: '' },
})

async function readerWith(options: {
  nodes: FakeNode[]
  outputs?: Record<string, string>
  agentStates?: Record<string, string>
}) {
  const fake = createFakeHost({ gh: () => failed('unused'), ...options })
  const plugin = await activate({ host: fake.host, log: () => undefined })
  const run = (params: Record<string, unknown>) => plugin.runCommand('agents.read', params, null)
  return { fake, run }
}

describe('github-issues agents.read', () => {
  it('refuses an agent that is not linked to any issue task and reads nothing', async () => {
    const { fake, run } = await readerWith({
      nodes: [
        task('task-1', ['issue:o/r#7'], 'agent-linked'),
        agent('agent-linked'),
        agent('agent-free'),
      ],
    })

    await expect(run({ projectId: 'p1', nodeId: 'agent-free' })).rejects.toMatchObject({
      code: 'agent-not-linked',
    })
    expect(fake.reads).toEqual([])
  })

  it('refuses an agent linked to a task that has no issue tag', async () => {
    const { fake, run } = await readerWith({
      nodes: [task('task-2', ['chore'], 'agent-chore'), agent('agent-chore')],
    })

    await expect(run({ projectId: 'p1', nodeId: 'agent-chore' })).rejects.toMatchObject({
      code: 'agent-not-linked',
    })
    expect(fake.reads).toEqual([])
  })

  it('returns the output, the issue and the observed state for a linked agent', async () => {
    const { run } = await readerWith({
      nodes: [task('task-1', ['issue:o/r#7'], 'agent-1'), agent('agent-1')],
      outputs: { 'agent-1': 'Should I rename the flag?' },
      agentStates: { 'agent-1': 'waiting' },
    })

    const result = await run({ projectId: 'p1', nodeId: 'agent-1' })

    expect(result).toEqual({
      nodeId: 'agent-1',
      issue: 'o/r#7',
      taskNodeId: 'task-1',
      sessionId: 'session-agent-1',
      output: 'Should I rename the flag?',
      truncated: false,
      agentState: 'waiting',
    })
  })

  it('bounds the returned output to the tail of at most MAX_READ_CHARS', async () => {
    const long = `${'a'.repeat(20000)}TAIL`
    const { run } = await readerWith({
      nodes: [task('task-1', ['issue:o/r#7'], 'agent-1'), agent('agent-1')],
      outputs: { 'agent-1': long },
    })

    const result = await run({ projectId: 'p1', nodeId: 'agent-1' })

    expect(result.output.length).toBe(MAX_READ_CHARS)
    expect(result.output.endsWith('TAIL')).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it('rejects a missing nodeId before reading anything', async () => {
    const { fake, run } = await readerWith({
      nodes: [task('task-1', ['issue:o/r#7'], 'agent-1'), agent('agent-1')],
    })

    await expect(run({ projectId: 'p1' })).rejects.toMatchObject({ code: 'invalid-params' })
    expect(fake.reads).toEqual([])
  })
})

describe('issue-coordinator skill names agents.read', () => {
  it('tells the coordinator to read waiting agents with agents.read and never answer decisions', () => {
    const skill = readFileSync(
      resolve(process.cwd(), 'plugins/github-issues/skills/issue-coordinator/SKILL.md'),
      'utf8',
    )

    expect(skill).toContain('read a waiting agent')
    expect(skill).toContain('agents.read')
    expect(skill).toContain('never answer product decisions yourself')
    expect(skill).not.toContain('--help')
  })
})
