import { classifyGhFailure, cleanTerminalOutput, GH_ENV, withRepo } from './gh.mjs'
import { commandError } from './errors.mjs'
import { findSeries } from './sequence.mjs'

const TERMINAL = new Set(['completed', 'cancelled', 'failed'])
const POLL_MS = 500
const TIMEOUT_MS = 60_000

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// Runs `command <args>` in the target project's directory through the host, which routes to its
// mount. Args are passed as an array, never as a shell string. Resolves to
// { ok: true, output } or { ok: false, error: { code, message } }. `classify` maps a failure.
export async function runProcess(
  host,
  target,
  command,
  args,
  { timeoutMs = TIMEOUT_MS, pollMs = POLL_MS, classify, label = command } = {},
) {
  const classifyFailure = classify ?? (options => classifyGhFailure(options))
  let handle
  try {
    handle = await host.operations.start({ target, command, args, timeoutMs })
  } catch (caught) {
    return { ok: false, error: classifyFailure({ status: 'failed', error: messageOf(caught) }) }
  }

  const settled = await pollUntilSettled(host, handle.operationId, {
    deadline: Date.now() + timeoutMs + 5_000,
    pollMs,
  })
  if (!settled) {
    await host.operations.cancel({ operationId: handle.operationId }).catch(() => undefined)
    return { ok: false, error: { code: 'gh-failed', message: `${label} timed out` } }
  }

  if (settled.status === 'completed' && settled.exitCode === 0) {
    return { ok: true, output: settled.output ?? '' }
  }
  return {
    ok: false,
    error: classifyFailure({
      status: settled.status,
      exitCode: settled.exitCode,
      output: settled.output,
      error: settled.error,
    }),
  }
}

export const ENV_COMMAND = '/usr/bin/env'
// Tried in order after the login shell's answer; the bare name falls back to the PTY's PATH.
export const GH_CANDIDATES = Object.freeze(['/opt/homebrew/bin/gh', '/usr/local/bin/gh', 'gh'])

// Resolved gh path per project. Only successes are cached, so installing gh later works.
const ghPaths = new Map()

export function resetGhPathCache() {
  ghPaths.clear()
}

// Runs `program <args>` through /usr/bin/env with the non-interactive gh environment.
export function runPlain(host, target, program, args, options = {}) {
  return runProcess(host, target, ENV_COMMAND, [...GH_ENV, program, ...args], {
    label: program,
    ...options,
  })
}

// ponytail: assumes a POSIX target (/usr/bin/env, sh -l); Windows targets need a cmd launcher.
async function resolveGhPath(host, target) {
  const key = target?.projectId ?? ''
  if (ghPaths.has(key)) {
    return ghPaths.get(key)
  }
  // The login shell's PATH sees Homebrew and user installs that a GUI-started app may miss.
  const shell = await runPlain(host, target, '/bin/sh', ['-lc', 'command -v gh'])
  const fromShell = shell.ok
    ? cleanTerminalOutput(shell.output)
        .split('\n')
        .map(line => line.trim())
        .find(line => line.startsWith('/'))
    : undefined
  const candidates = [...new Set([fromShell, ...GH_CANDIDATES].filter(Boolean))]
  const found = await findSeries(candidates, async candidate =>
    (await runPlain(host, target, candidate, ['--version'])).ok ? candidate : null,
  )
  if (found) {
    ghPaths.set(key, found)
  }
  return found ?? null
}

// Runs `gh <args>` with an explicit --repo (when given), no prompts, colours or pager.
export async function runGh(host, target, args, { repo, ...options } = {}) {
  const gh = await resolveGhPath(host, target)
  if (!gh) {
    return { ok: false, error: classifyGhFailure({ status: 'failed', exitCode: 127 }) }
  }
  return runPlain(host, target, gh, withRepo(args, repo), { label: 'gh', ...options })
}

// For writes: returns the output, or throws the coded gh failure.
export async function runGhOrThrow(host, target, args, options) {
  const result = await runGh(host, target, args, options)
  if (!result.ok) {
    throw commandError(result.error.code, result.error.message)
  }
  return result.output
}

// Recursive polling keeps each host call sequential without a loop; resolves to null on deadline.
async function pollUntilSettled(host, operationId, { deadline, pollMs }) {
  const current = await host.operations.get({ operationId })
  if (TERMINAL.has(current.status)) {
    return current
  }
  if (Date.now() > deadline) {
    return null
  }
  await delay(pollMs)
  return pollUntilSettled(host, operationId, { deadline, pollMs })
}

function messageOf(caught) {
  return caught instanceof Error ? caught.message : String(caught)
}
