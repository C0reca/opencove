import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { activate } from '../../../plugins/github-issues/main.mjs'
import {
  ALLOW,
  buildAgentSettings,
  GUARD_SCRIPT,
} from '../../../plugins/github-issues/lib/agentSettings.mjs'
import { COMMON_GIT_DIR, createFakeHost, failed, ok, remotes } from './githubIssuesFakeHost'

const ROOT = '/Users/me/.opencove/worktrees/issue-40'

describe('github-issues agent settings', () => {
  const settings = buildAgentSettings({ root: ROOT, execPath: '/Applications/OpenCove' })

  it('denies merge, close, gh api and force pushes, and edits under .claude/', () => {
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        'Bash(gh pr merge:*)',
        'Bash(gh pr close:*)',
        'Bash(gh issue close:*)',
        'Bash(gh api:*)',
        'Bash(git push --force:*)',
        'Bash(git push -f:*)',
        'Bash(git push --force-with-lease:*)',
        'Edit(/.claude/**)',
      ]),
    )
    // Write path rules are never consulted by Claude Code, so Write is not listed.
    expect(settings.permissions.deny.some(rule => rule.startsWith('Write('))).toBe(false)
  })

  it('allows read-only gh with -R and --repo, and the plugin commands the coordinator needs', () => {
    expect(ALLOW).toEqual(
      expect.arrayContaining([
        'Bash(gh pr list -R:*)',
        'Bash(gh pr view --repo:*)',
        'Bash(gh issue list -R:*)',
        'Bash(gh issue view --repo:*)',
        'Bash(opencove plugin run github-issues agents.status:*)',
        'Bash(opencove plugin run github-issues agents.read:*)',
        'Bash(opencove plugin run github-issues issues.list:*)',
        'Bash(opencove plugin run github-issues issue.assign:*)',
        'Bash(opencove plugin run github-issues issue.request-review:*)',
        'Bash(opencove plugin run github-issues issue.close:*)',
        'Bash(opencove plugin skill github-issues:*)',
        'Bash(opencove project list:*)',
      ]),
    )
    expect(ALLOW.some(rule => rule.includes('gh pr merge'))).toBe(false)
    expect(ALLOW.some(rule => /close-manual|assign-untrusted/.test(rule))).toBe(false)
  })

  it('runs the guard in exec form: env, the Electron-capable runtime, the script and the root', () => {
    const [hook] = settings.hooks.PreToolUse[0].hooks

    expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash')
    expect(hook).toEqual({
      type: 'command',
      command: '/usr/bin/env',
      args: ['ELECTRON_RUN_AS_NODE=1', '/Applications/OpenCove', GUARD_SCRIPT, ROOT],
    })
    expect(existsSync(GUARD_SCRIPT)).toBe(true)
  })

  it('the installed guard answers a real PreToolUse call through that exact command line', () => {
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'a && gh pr merge 1' },
      cwd: ROOT,
    })

    const stdout = execFileSync(
      '/usr/bin/env',
      ['ELECTRON_RUN_AS_NODE=1', process.execPath, GUARD_SCRIPT, ROOT],
      { input, encoding: 'utf8' },
    )

    expect(JSON.parse(stdout).hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    })
  })

  it('the installed guard allows a read-only gh call through the same command line', () => {
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'gh pr list -R C0reca/opencove' },
      cwd: ROOT,
    })

    const stdout = execFileSync(
      '/usr/bin/env',
      ['ELECTRON_RUN_AS_NODE=1', process.execPath, GUARD_SCRIPT, ROOT],
      { input, encoding: 'utf8' },
    )

    expect(stdout).toBe('')
  })
})

describe('github-issues guard file write', () => {
  it('writes the settings and adds the file to the common info/exclude before launch', async () => {
    const fake = createFakeHost({
      gh: (args, command = 'gh') => {
        if (command === 'opencove' && args[0] === 'space' && args[1] === 'list') {
          return ok(
            JSON.stringify({
              ok: true,
              value: {
                spaces: [
                  { id: 'space-root', name: 'Main', parentSpaceId: null, directoryPath: '/r' },
                ],
              },
            }),
          )
        }
        if (command === 'opencove' && args[0] === 'space') {
          return ok('{"ok":true,"value":{"childSpace":{"id":"space-child"}}}')
        }
        if (command === 'opencove') {
          return ok('{"ok":true}')
        }
        if (args.join(' ') === 'remote -v') {
          return ok(remotes('C0reca/opencove'))
        }
        if (args[0] === 'issue' && args[1] === 'view') {
          return ok(
            JSON.stringify({
              number: 5,
              title: 'Login bug',
              body: '',
              url: 'https://github.com/C0reca/opencove/issues/5',
              author: { login: 'C0reca' },
              labels: [],
            }),
          )
        }
        return failed('unexpected')
      },
    })
    const plugin = await activate({ host: fake.host, log: () => undefined })

    await plugin.runCommand('issue.assign', { projectId: 'p1', number: 5 }, null)

    const content = String(fake.files.get('space-child:.claude/settings.local.json'))
    expect(JSON.parse(content).hooks.PreToolUse[0].hooks[0].args).toContain(
      '/Users/me/.opencove/worktrees/space-child',
    )
    const exclude = fake.shellCalls.at(-1) ?? []
    expect(exclude[1]).toContain('info/exclude')
    expect(exclude).toContain(COMMON_GIT_DIR)
    expect(exclude).toContain('.claude/settings.local.json')
  })
})
