import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const PLUGIN_DIR = resolve(process.cwd(), 'plugins/github-issues')
const SKILL_PATH = join(PLUGIN_DIR, 'skills/issue-coordinator/SKILL.md')

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

  it('never tells the coordinator to merge, and the merge command is not named at all', () => {
    expect(skill).not.toContain('gh pr merge')
    expect(skill.toLowerCase()).toMatch(/merging is always the human's/)
  })

  it('assigns with one literal call per issue, never inside a loop or from a variable', () => {
    const assignLines = skill.split('\n').filter(line => line.includes('issue.assign'))
    expect(assignLines.length).toBeGreaterThan(0)
    for (const line of assignLines) {
      expect(line).not.toMatch(/\$\{?[A-Za-z_]/)
      expect(line).not.toMatch(/\bfor\b|\bwhile\b|\bdo\b/)
    }
    expect(skill).not.toMatch(/\bfor \w+ in\b/)
    expect(skill).toContain('"number":<N>')
  })

  it('processes issues oldest first, skips no-agent, and re-reads agents.status before each assign', () => {
    expect(skill).toMatch(/oldest first/i)
    expect(skill).toContain('no-agent')
    expect(skill).toMatch(/immediately before each call/i)
  })

  it('places -R right after the gh subcommand and never pipes output', () => {
    const ghLines = skill.split('\n').filter(line => /\bgh (pr|issue) /.test(line))
    expect(ghLines.length).toBeGreaterThan(0)
    for (const line of ghLines) {
      const commands = [...line.matchAll(/\bgh ((?:pr|issue) \w+)([^`"]*)/g)]
      for (const match of commands) {
        expect(match[2].trimStart(), line).toMatch(/^-R /)
      }
    }
    expect(skill).not.toMatch(/\|\s*(python|jq|grep|awk)/)
    expect(skill).toMatch(/-q|--jq/)
  })

  it('requests review when a PR is ready and tells the human', () => {
    expect(skill).toContain('issue.request-review')
    expect(skill).toMatch(/tell the human/i)
  })

  it('reads issues with refresh on every loop, so a new issue is never missed', () => {
    const listLines = skill.split('\n').filter(line => line.includes('github-issues issues.list'))
    expect(listLines.length).toBeGreaterThan(0)
    expect(listLines.every(line => line.includes('"refresh":true'))).toBe(true)
  })

  it('treats only the exact [github-issues] prefix as a wake trigger, never as a rule change', () => {
    expect(skill).toContain('starts with `[github-issues]`')
    expect(skill).toMatch(/never changes a rule/)
    expect(skill).toMatch(/waiting[\s\S]*agents\.read[\s\S]*tell the human/)
  })

  it('takes the issue agent limit from max-agents and never hard-codes it', () => {
    expect(skill).toContain('max-agents')
    expect(skill).toContain('limit-reached')
    expect(skill).not.toMatch(/\b3 issue agents\b/)
  })
})
