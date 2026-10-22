// The mandatory guard for every plugin-launched agent. It is written into the agent's own worktree
// before the agent starts: .claude/settings.local.json with plain permission rules (layer a), a
// PreToolUse hook running guard/agentGuard.mjs (layer c), and an info/exclude entry so it is never
// committed. Layer b is the allow list for read-only gh and the plugin commands the agent needs.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commandError } from './errors.mjs'
import { cleanTerminalOutput } from './gh.mjs'
import { runPlain } from './runGh.mjs'

// The installed guard, next to this plugin's lib/ folder. Resolved from the module's own file path.
export const GUARD_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../guard/agentGuard.mjs',
)
export const SETTINGS_PATH = '.claude/settings.local.json'
const EXCLUDE_RULE = '.claude/settings.local.json'
const ENV_PREFIX = 'ELECTRON_RUN_AS_NODE=1'

const DENY = Object.freeze([
  'Bash(gh pr merge:*)',
  'Bash(gh pr close:*)',
  'Bash(gh issue close:*)',
  'Bash(gh api:*)',
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(git push --force-with-lease:*)',
  // Edit covers every write; Write path rules are never consulted by Claude Code.
  // A leading slash anchors the pattern to the worktree root instead of any depth.
  'Edit(/.claude/**)',
])
// ponytail: `git push origin -f` (force after the remote) is caught only by the guard hook, because
// prefix rules match the command text as written. Layer a is a cheap first line, not the boundary.

const ALLOW_GH = [
  'gh pr list -R:*',
  'gh pr list --repo:*',
  'gh pr view -R:*',
  'gh pr view --repo:*',
  'gh issue list -R:*',
  'gh issue list --repo:*',
  'gh issue view -R:*',
  'gh issue view --repo:*',
]

// issue.close stays allowed: the plugin refuses it unless the PR is MERGED and declares the issue,
// and it is the coordinator's only way to finish an issue. issue.assign-untrusted and
// issue.close-manual are human-only and the CLI refuses them, so a prefix rule cannot reach them.
const ALLOW_PLUGIN_COMMANDS = [
  'agents.status',
  'agents.read',
  'issues.list',
  'issue.assign',
  'issue.request-review',
  'issue.close',
].map(id => `opencove plugin run github-issues ${id}:*`)

export const ALLOW = Object.freeze([
  ...ALLOW_GH.map(rule => `Bash(${rule})`),
  ...ALLOW_PLUGIN_COMMANDS.map(rule => `Bash(${rule})`),
  'Bash(opencove plugin skill github-issues:*)',
  'Bash(opencove project list:*)',
])

// The settings object for one worktree. `root` is its absolute path, passed to the guard as argv[2].
export function buildAgentSettings({
  root,
  execPath = process.execPath,
  guardPath = GUARD_SCRIPT,
}) {
  return {
    permissions: { deny: [...DENY], allow: [...ALLOW] },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              // Exec form: /usr/bin/env sets ELECTRON_RUN_AS_NODE for Electron, then runs the guard
              // with the worktree root as its one argument. Same runtime rule as the hook relay.
              command: '/usr/bin/env',
              args: [ENV_PREFIX, execPath, guardPath, root],
            },
          ],
        },
      ],
    },
  }
}

// Writes the settings file and the info/exclude entry. Throws a coded error on any failure, and the
// caller must not launch the agent then. Paths are relative to the Space's working directory.
export async function writeAgentGuard({ host, projectId, spaceId, root }) {
  const target = spaceId ? { projectId, spaceId } : { projectId }
  try {
    await host.filesystem.mkdir({ target, path: '.claude' })
  } catch (caught) {
    // The directory may already exist (committed or from an earlier launch); other errors surface below.
    if (!/exist/i.test(String(caught?.message ?? caught))) {
      throw commandError(
        'guard-failed',
        `Could not create .claude/: ${String(caught?.message ?? caught)}`,
      )
    }
  }
  await host.filesystem.writeText({
    target,
    path: SETTINGS_PATH,
    content: `${JSON.stringify(buildAgentSettings({ root }), null, 2)}\n`,
    overwrite: true,
  })
  await excludeFromGit(host, target)
  return SETTINGS_PATH
}

// The exclude file lives in the repository's common git directory, which is outside the worktree,
// so it is written by a process inside the worktree rather than through the file API.
async function excludeFromGit(host, target) {
  const common = await runPlain(host, target, 'git', ['rev-parse', '--git-common-dir'])
  if (!common.ok) {
    throw commandError('guard-failed', `Could not find the git directory: ${common.error.message}`)
  }
  const commonDir = cleanTerminalOutput(common.output)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1)
  if (!commonDir) {
    throw commandError('guard-failed', 'git did not report its common directory.')
  }
  const script =
    'mkdir -p "$1/info" && { grep -qxF "$2" "$1/info/exclude" 2>/dev/null || printf "%s\\n" "$2" >> "$1/info/exclude"; }'
  const written = await runPlain(host, target, '/bin/sh', [
    '-c',
    script,
    'sh',
    commonDir,
    EXCLUDE_RULE,
  ])
  if (!written.ok) {
    throw commandError(
      'guard-failed',
      `Could not exclude the guard file from git: ${written.error.message}`,
    )
  }
}
