import { describe, expect, it } from 'vitest'
import { decide, parseHookInput } from '../../../plugins/github-issues/guard/agentGuard.mjs'

const ROOT = '/Users/me/.opencove/worktrees/issue-40-autonomous'

function reasonOf(command: string, cwd = ROOT): string | null {
  const output = decide({ tool_name: 'Bash', tool_input: { command }, cwd }, ROOT) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string }
  } | null
  if (output === null) {
    return null
  }
  expect(output.hookSpecificOutput.permissionDecision).toBe('deny')
  return output.hookSpecificOutput.permissionDecisionReason
}

describe('github-issues agent guard: denied', () => {
  const denied: Array<[string, string]> = [
    ['gh pr merge 1', 'gh pr merge'],
    ['gh pr merge -R C0reca/opencove 1', 'gh pr merge'],
    ['gh -R C0reca/opencove pr merge 1', 'gh pr merge'],
    ['gh pr close 1', 'gh pr close'],
    ['gh issue close 3', 'gh issue close'],
    ['gh api repos/C0reca/opencove/pulls/1/merge', 'gh api'],
    ['gh api graphql -f query=x', 'gh api'],
    ['a && gh pr merge 1', 'gh pr merge'],
    ['true; gh pr merge 1', 'gh pr merge'],
    ['echo ok | gh issue close 3', 'gh issue close'],
    ['env FOO=1 gh pr merge 1', 'gh pr merge'],
    ['bash -c "gh pr merge 1"', 'gh pr merge'],
    ['echo $(gh issue close 3)', 'gh issue close'],
    ['git push --force origin b', '--force'],
    ['git push origin b --force', '--force'],
    ['git push -f origin b', '-f'],
    ['git push -fu origin b', '-f'],
    ['git push --force-with-lease origin b', '--force-with-lease'],
    ['git push --force-with-lease=b:abc origin b', '--force-with-lease'],
    ['git push origin +b:c', '+refspec'],
    ['git push origin HEAD:main', 'main'],
    ['git push origin main', 'main'],
    ['git push origin HEAD:refs/heads/main', 'main'],
    ['git push origin b:master', 'master'],
    ['git push origin :main', 'main'],
    ['git push origin :refs/heads/main', 'main'],
    ['git push origin refs/heads/*:refs/heads/*', 'wildcard'],
    ['git -C /elsewhere reset --hard', 'outside the worktree'],
    ['git -C ../other reset --hard', 'outside the worktree'],
    ['cd /tmp && git reset --hard', 'outside the worktree'],
    ['rm -rf ../x', 'outside the worktree'],
    ['rm -rf /tmp/foo', 'outside the worktree'],
    ['rm -r ~/x', 'cannot be verified'],
    ['rm -rf "$HOME"', 'cannot be verified'],
    ['rm -rf .', 'worktree root'],
    ['rm --recursive ../y', 'outside the worktree'],
    ['echo x > .claude/settings.local.json', '.claude/'],
    ['echo x >> ./.claude/hooks.json', '.claude/'],
    ['echo x 2> .claude/x', '.claude/'],
    ['tee .claude/settings.local.json', '.claude/'],
    ['sed -i s/a/b/ .claude/settings.local.json', '.claude/'],
    ['cp evil.json .claude/settings.local.json', '.claude/'],
    ['mv x .claude/y', '.claude/'],
    ['rm -rf .claude', '.claude/'],
    ['git -C ../other push --force origin b', '--force'],
    ['GIT_DIR=/x git status', 'GIT_DIR'],
  ]

  it.each(denied)('denies %s', (command, expected) => {
    const reason = reasonOf(command)
    expect(reason).not.toBeNull()
    expect(reason).toContain(expected)
  })
})

describe('github-issues agent guard: allowed (normal permissions decide)', () => {
  const allowed = [
    'gh pr list -R C0reca/opencove --state all',
    'gh pr view 12 -R C0reca/opencove --json state,url',
    'gh issue view 40 --repo C0reca/opencove',
    'git status',
    'git push origin issue-40-autonomous',
    'git push origin HEAD',
    'git -C ./src log --oneline',
    'git reset --hard',
    'git -C . reset --hard HEAD~1',
    'rm -rf node_modules',
    'rm -rf ./dist/out',
    'rm -rf src/../dist',
    'rm file.txt',
    'cd src && rm -rf build',
    'sed -i s/a/b/ src/index.ts',
    'echo hi > out.txt',
    'cat .claude/settings.local.json',
    'opencove plugin run github-issues agents.status --params \'{"projectId":"p1"}\'',
    'echo "gh pr merge is blocked" ',
    "echo 'rm -rf /' ",
    'ls ../other',
    'npm test -- --run',
  ]

  it.each(allowed)('allows %s', command => {
    expect(reasonOf(command)).toBeNull()
  })

  it('allows a non-Bash tool and a missing command', () => {
    expect(decide({ tool_name: 'Edit', tool_input: { command: 'gh pr merge 1' } }, ROOT)).toBeNull()
    expect(decide({ tool_name: 'Bash', tool_input: {} }, ROOT)).toBeNull()
  })

  it('uses the hook cwd for relative targets', () => {
    expect(reasonOf('rm -rf ../x', `${ROOT}/src`)).toBeNull()
    expect(reasonOf('rm -rf ../../x', `${ROOT}/src`)).toContain('outside the worktree')
  })
})

describe('github-issues agent guard: input parsing', () => {
  it('parses a JSON object and reports malformed input as null', () => {
    expect(parseHookInput('{"tool_name":"Bash"}')).toEqual({ tool_name: 'Bash' })
    expect(parseHookInput('not json')).toBeNull()
    expect(parseHookInput('[1,2]')).toEqual([1, 2])
  })
})
