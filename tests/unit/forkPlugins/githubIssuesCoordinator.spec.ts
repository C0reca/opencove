import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { activate } from '../../../plugins/github-issues/main.mjs'
import { coordinatorPrompt } from '../../../plugins/github-issues/lib/coordinator.mjs'
import { createFakeHost, failed, type FakeNode } from './githubIssuesFakeHost'

const PLUGIN_DIR = resolve(process.cwd(), 'plugins/github-issues')
const SKILL_PATH = join(PLUGIN_DIR, 'skills/issue-coordinator/SKILL.md')

const coordinatorNode = (id: string): FakeNode => ({
  id,
  kind: 'agent',
  title: 'Issue coordinator',
  data: { kind: 'agent', prompt: '' },
})

async function runCoordinator(
  options: {
    nodes?: FakeNode[]
    sessions?: Record<string, string>
    prefs?: Record<string, string>
  } = {},
) {
  const fake = createFakeHost({ gh: () => failed('unused'), ...options })
  const plugin = await activate({ host: fake.host, log: () => undefined })
  const run = (params: Record<string, unknown>) =>
    plugin.runCommand('coordinator.launch', params, null)
  return { fake, run }
}

describe('github-issues coordinator.launch', () => {
  it('always launches in normal permission mode, even when the repository is auto-approved', async () => {
    const { fake, run } = await runCoordinator({
      prefs: { 'auto-approve-repos': 'c0reca/opencove' },
    })

    const result = await run({ projectId: 'p1' })

    expect(fake.launches).toHaveLength(1)
    expect(fake.launches[0]).toMatchObject({
      target: { projectId: 'p1' },
      title: 'Issue coordinator',
      provider: 'claude-code',
      agentFullAccess: false,
    })
    expect(result).toEqual({
      nodeId: expect.any(String),
      projectId: 'p1',
      reused: false,
      agentFullAccess: false,
    })
  })

  it('tells the agent to load the skill and gives it the project', async () => {
    const { fake, run } = await runCoordinator()

    await run({ projectId: 'p1' })

    const prompt = String(fake.launches[0].prompt)
    expect(prompt).toContain('opencove plugin skill github-issues issue-coordinator')
    expect(prompt).toContain('project p1')
    expect(prompt).toBe(coordinatorPrompt('p1'))
  })

  it('reuses a coordinator whose session is still running and launches none', async () => {
    const { fake, run } = await runCoordinator({
      nodes: [coordinatorNode('coord-live')],
      sessions: { 'coord-live': 'running' },
    })

    const result = await run({ projectId: 'p1' })

    expect(fake.launches).toHaveLength(0)
    expect(result).toEqual({
      nodeId: 'coord-live',
      projectId: 'p1',
      reused: true,
      agentFullAccess: null,
    })
  })

  it('launches a new coordinator when the existing one is no longer running', async () => {
    const { fake, run } = await runCoordinator({
      nodes: [coordinatorNode('coord-old')],
      sessions: { 'coord-old': 'exited' },
    })

    const result = await run({ projectId: 'p1' })

    expect(fake.launches).toHaveLength(1)
    expect(result).toMatchObject({ reused: false, agentFullAccess: false })
  })

  it('requires a projectId', async () => {
    const { fake, run } = await runCoordinator()

    await expect(run({})).rejects.toMatchObject({ code: 'invalid-params' })
    expect(fake.launches).toHaveLength(0)
  })
})

describe('github-issues issue-coordinator skill', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8')

  it('does not mention human-only or forced commands', () => {
    const lowered = skill.toLowerCase()

    expect(lowered).not.toContain('close-manual')
    expect(lowered).not.toContain('assign-untrusted')
    expect(lowered).not.toContain('force')
  })

  it('names direct GitHub writes only inside a prohibition, never as an instruction', () => {
    const writes = ['gh pr edit', 'gh issue close']
    const lines = skill.split('\n')
    for (const write of writes) {
      for (const line of lines.filter(text => text.includes(write))) {
        expect(line.toLowerCase(), line).toMatch(/never/)
      }
    }
  })

  it('does not tell the coordinator to edit a PR after pr-not-linked', () => {
    const branch = skill.slice(skill.indexOf('`pr-not-linked`'))
    const section = branch.slice(0, branch.indexOf('\n- `pr-not-found`'))

    expect(section).toContain('issue.request-review')
    expect(section).not.toMatch(/gh pr edit|--body/)
  })

  it('has frontmatter whose name matches its directory', () => {
    const match = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(skill)

    expect(match?.[1]).toBe('issue-coordinator')
    expect(match?.[2].length).toBeGreaterThan(0)
  })

  it('is declared in the manifest at a path that exists', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, 'opencove.plugin.json'), 'utf8'))
    const entry = manifest.contributes.skills.find(
      (skillEntry: { id: string }) => skillEntry.id === 'issue-coordinator',
    )

    expect(entry.path).toBe('skills/issue-coordinator/SKILL.md')
    expect(existsSync(join(PLUGIN_DIR, entry.path))).toBe(true)
  })

  it('keeps human-only commands out of the CLI usage text', () => {
    const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, 'opencove.plugin.json'), 'utf8'))
    for (const command of manifest.contributes.commands) {
      if (command.menus?.includes('sidebar') && command.id.endsWith('close-manual')) {
        expect(command.usage).toBeUndefined()
      }
    }
  })
})
