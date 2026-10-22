// PreToolUse guard for agents the github-issues plugin launches. Claude Code runs it before every
// Bash call (see lib/agentSettings.mjs). decide() is pure: it returns a deny decision or null.
// Anything null keeps the normal permission flow; this guard never approves a call.
//
// ponytail: the parser is a small shell tokenizer, not a shell. It splits on && || ; | & and
// newlines, handles '…', "…" and \x, follows `cd`, `git -C`, `sh -c`, `env` and `command`
// wrappers, and checks $(…) and backtick bodies. Not handled: eval, heredocs, brace or glob
// expansion, and variables. A target containing $ or ` is unverifiable and is denied where it
// matters. Programs other than gh, git, rm, sed, tee, cp and similar writers are not inspected.
// The permissions.deny rules in settings.local.json cover the plain prefixes independently.
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tokenize } from './tokenize.mjs'

const MAX_DEPTH = 3
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash'])
const WRAPPERS = new Set(['command', 'exec', 'nohup', 'time', 'builtin'])
const WRITERS = new Set(['tee', 'cp', 'mv', 'rm', 'touch', 'ln', 'install', 'truncate', 'chmod'])
const WRITE_OPS = new Set(['>', '>>', '>|', '&>'])
const PROTECTED_BRANCHES = new Set(['main', 'master'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

const deny = reason => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: `OpenCove agent guard: ${reason}`,
  },
})

// Absolute path of an argument relative to cwd, or null when it cannot be known (~, $, `).
function resolvePath(cwd, arg) {
  if (arg === undefined || arg.startsWith('~') || arg.includes('$') || arg.includes('`')) {
    return null
  }
  return posix.resolve(cwd, arg)
}

// 'root' | 'inside' | 'outside' for an absolute path against the worktree root.
function placeOf(path, root) {
  if (path === root) {
    return 'root'
  }
  return path.startsWith(root === '/' ? '/' : `${root}/`) ? 'inside' : 'outside'
}

function touchesClaude(path, root) {
  const claude = posix.join(root, '.claude')
  return path === claude || path.startsWith(`${claude}/`)
}

// Removes leading VAR=value assignments, env and command wrappers. Returns the assignments too.
function unwrap(words) {
  const assignments = []
  let rest = words
  let changed = true
  while (changed && rest.length > 0) {
    changed = false
    if (ASSIGNMENT.test(rest[0])) {
      assignments.push(rest[0])
      rest = rest.slice(1)
      changed = true
    } else if (rest[0] === 'env') {
      rest = rest.slice(1)
      while (rest.length > 0 && (rest[0].startsWith('-') || ASSIGNMENT.test(rest[0]))) {
        if (ASSIGNMENT.test(rest[0])) {
          assignments.push(rest[0])
        }
        rest = rest.slice(rest[0] === '-u' || rest[0] === '-C' ? 2 : 1)
      }
      changed = true
    } else if (WRAPPERS.has(rest[0])) {
      rest = rest.slice(1)
      changed = true
    }
  }
  return { words: rest, assignments }
}

function ghViolation(words) {
  const positional = []
  for (let i = 1; i < words.length && positional.length < 2; i++) {
    if (words[i] === '-R' || words[i] === '--repo') {
      i++
    } else if (!words[i].startsWith('-')) {
      positional.push(words[i])
    }
  }
  const [first, second] = positional
  if (first === 'api') {
    return 'gh api is blocked for plugin agents; use the plugin commands or read-only gh pr/issue list and view.'
  }
  if (
    (first === 'pr' && (second === 'merge' || second === 'close')) ||
    (first === 'issue' && second === 'close')
  ) {
    return `gh ${first} ${second} is blocked: a human merges, and agents close issues only with issue.close.`
  }
  return null
}

function isForceFlag(word) {
  if (['--force', '--mirror', '--force-if-includes'].includes(word)) {
    return true
  }
  if (word === '--force-with-lease' || word.startsWith('--force-with-lease=')) {
    return true
  }
  return word.startsWith('-') && !word.startsWith('--') && word.slice(1).includes('f')
}

function pushViolation(rest) {
  if (rest.some(isForceFlag)) {
    return 'git push with --force, -f, --force-with-lease or --mirror is blocked.'
  }
  const refspecs = rest.filter(word => !word.startsWith('-')).slice(1)
  for (const refspec of refspecs) {
    if (refspec.startsWith('+')) {
      return `git push with a +refspec (${refspec}) is a force push and is blocked.`
    }
    const destination = (
      refspec.includes(':') ? refspec.slice(refspec.lastIndexOf(':') + 1) : refspec
    ).replace(/^refs\/heads\//, '')
    if (PROTECTED_BRANCHES.has(destination)) {
      return `git push to ${destination} is blocked; agents push only their issue branch.`
    }
    if (destination.includes('*')) {
      return `git push with a wildcard destination (${refspec}) is blocked.`
    }
  }
  return null
}

// Walks git's global options (-C dir, -c k=v, --git-dir x) to find the subcommand and directory.
function gitViolation(words, cwd, root) {
  let dir = cwd
  let i = 1
  while (i < words.length && words[i].startsWith('-')) {
    if (words[i] === '-C') {
      dir = resolvePath(dir, words[i + 1])
      i += 2
    } else if (['-c', '--git-dir', '--work-tree', '--namespace'].includes(words[i])) {
      i += 2
    } else {
      i++
    }
  }
  const sub = words[i]
  const rest = words.slice(i + 1)
  if (sub === 'reset' && rest.includes('--hard')) {
    if (dir === null) {
      return 'git reset --hard in a directory that cannot be verified is blocked.'
    }
    if (placeOf(dir, root) === 'outside') {
      return `git reset --hard outside the worktree (${dir}) is blocked.`
    }
  }
  if (sub === 'push') {
    return pushViolation(rest)
  }
  return null
}

// Recursive removal is only allowed inside the worktree, and never of the root itself.
function rmViolation(words, cwd, root) {
  let recursive = false
  let endOfOptions = false
  const targets = []
  for (const word of words.slice(1)) {
    if (!endOfOptions && word === '--') {
      endOfOptions = true
    } else if (!endOfOptions && word === '--recursive') {
      recursive = true
    } else if (!endOfOptions && word.startsWith('-') && word.length > 1) {
      recursive = recursive || /[rR]/.test(word.slice(1))
    } else {
      targets.push(word)
    }
  }
  if (!recursive) {
    return null
  }
  for (const target of targets) {
    const path = resolvePath(cwd, target)
    if (path === null) {
      return `rm -r with a target that cannot be verified (${target}) is blocked.`
    }
    const place = placeOf(path, root)
    if (place === 'root') {
      return 'rm -r of the worktree root is blocked.'
    }
    if (place === 'outside') {
      return `rm -r outside the worktree (${path}) is blocked.`
    }
  }
  return null
}

// Writes into .claude/: redirections, writer commands and sed -i.
function claudeWriteViolation(program, words, redirects, cwd, root) {
  for (const { op, target } of redirects) {
    if (!WRITE_OPS.has(op)) {
      continue
    }
    const path = resolvePath(cwd, target)
    if (path === null || touchesClaude(path, root)) {
      return `writing to .claude/ (${target}) is blocked for plugin agents.`
    }
  }
  const inPlaceSed = program === 'sed' && words.some(word => /^-[a-zA-Z]*i|^--in-place/.test(word))
  if (!WRITERS.has(program) && !inPlaceSed) {
    return null
  }
  for (const arg of words.slice(1).filter(word => !word.startsWith('-'))) {
    const path = resolvePath(cwd, arg)
    if (path === null) {
      return `${program} with a target that cannot be verified (${arg}) is blocked.`
    }
    if (touchesClaude(path, root)) {
      return `${program} on .claude/ is blocked for plugin agents.`
    }
  }
  return null
}

function segmentViolation(segment, cwd, root, depth) {
  const { words, assignments } = unwrap(segment.words)
  const program = words.length > 0 ? posix.basename(words[0]) : ''
  const redirectReason = claudeWriteViolation(program, words, segment.redirects, cwd, root)
  if (redirectReason || words.length === 0) {
    return redirectReason
  }
  if (program === 'gh') {
    return ghViolation(words)
  }
  if (program === 'git') {
    if (assignments.some(item => /^GIT_(DIR|WORK_TREE)=/.test(item))) {
      return 'setting GIT_DIR or GIT_WORK_TREE is blocked for plugin agents.'
    }
    return gitViolation(words, cwd, root)
  }
  if (program === 'rm') {
    return rmViolation(words, cwd, root)
  }
  if (SHELLS.has(program) && words.includes('-c')) {
    const body = words[words.indexOf('-c') + 1]
    return body === undefined ? null : findViolation(body, cwd, root, depth + 1)
  }
  return null
}

// Returns the first reason to deny, or null. `cd` inside the command moves the working directory.
function findViolation(command, cwd, root, depth) {
  if (depth > MAX_DEPTH) {
    return 'the command nests too deeply to check.'
  }
  const { segments, substitutions } = tokenize(command)
  for (const body of substitutions) {
    const reason = findViolation(body, cwd, root, depth + 1)
    if (reason) {
      return reason
    }
  }
  let dir = cwd
  for (const segment of segments) {
    const { words } = unwrap(segment.words)
    if (words[0] === 'cd') {
      dir = resolvePath(dir, words[1] ?? root)
      if (dir === null) {
        return 'cd to a directory that cannot be verified is blocked.'
      }
      continue
    }
    const reason = segmentViolation(segment, dir, root, depth)
    if (reason) {
      return reason
    }
  }
  return null
}

// input: the PreToolUse JSON. worktreeRoot: absolute path of the agent's worktree.
// Returns the hook output to print, or null to leave the decision to the normal permission flow.
export function decide(input, worktreeRoot) {
  const command = input?.tool_input?.command
  if (
    input?.tool_name !== 'Bash' ||
    typeof command !== 'string' ||
    typeof worktreeRoot !== 'string'
  ) {
    return null
  }
  const root = posix.resolve(worktreeRoot)
  const start =
    typeof input.cwd === 'string' && posix.isAbsolute(input.cwd) ? posix.resolve(input.cwd) : root
  const reason = findViolation(command, start, root, 0)
  return reason ? deny(reason) : null
}

// Parses the hook JSON. Malformed input is reported as null; the caller then allows the call.
export function parseHookInput(text) {
  try {
    const value = JSON.parse(String(text ?? ''))
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const input = parseHookInput(await readStdin())
  if (!input) {
    process.stderr.write('OpenCove agent guard: malformed hook input, allowing the call.\n')
    return
  }
  const root = process.argv[2] ?? input.cwd
  if (typeof root !== 'string' || !posix.isAbsolute(root)) {
    process.stderr.write('OpenCove agent guard: no worktree root, allowing the call.\n')
    return
  }
  const output = decide(input, root)
  if (output) {
    process.stdout.write(`${JSON.stringify(output)}\n`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === posix.resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(`OpenCove agent guard: ${error?.message ?? error}, allowing the call.\n`)
  })
}
