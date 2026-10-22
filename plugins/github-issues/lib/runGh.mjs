import { classifyGhFailure, cleanTerminalOutput, GH_ENV, outputExcerpt, withRepo } from './gh.mjs'
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
  const classifyFailure =
    classify ?? (label === 'gh' ? classifyGhFailure : options => describeFailure(label, options))
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
    const excerpt = outputExcerpt(
      (await host.operations.get({ operationId: handle.operationId }).catch(() => null))?.output,
    )
    return {
      ok: false,
      error: {
        code: label === 'gh' ? 'gh-failed' : 'cli-failed',
        message: `${label} timed out after ${Math.round(timeoutMs / 1000)} s${excerpt ? `: ${excerpt}` : ' (no output)'}`,
      },
    }
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

import { homedir } from 'node:os'

export const ENV_COMMAND = '/usr/bin/env'

// Install locations tried after the login shell's answer; the bare name falls back to the PTY's
// PATH. The opencove list mirrors the desktop "Install CLI" targets (cliPathInstaller).
export const GH_CANDIDATES = Object.freeze(['/opt/homebrew/bin/gh', '/usr/local/bin/gh', 'gh'])
export function opencoveCandidates(home = homedir()) {
  return [
    '/opt/homebrew/bin/opencove',
    '/usr/local/bin/opencove',
    `${home}/.local/bin/opencove`,
    'opencove',
  ]
}

const TOOLS = {
  gh: { candidates: () => GH_CANDIDATES, probe: ['--version'], missing: 'gh-missing' },
  opencove: { candidates: () => opencoveCandidates(), probe: ['--help'], missing: 'cli-missing' },
}

// Resolved path per tool and project. Only successes are cached, so a later install works.
const toolPaths = new Map()

export function resetGhPathCache() {
  toolPaths.clear()
}

// Runs `program <args>` through /usr/bin/env with the plain, non-interactive environment.
export function runPlain(host, target, program, args, options = {}) {
  return runProcess(host, target, ENV_COMMAND, [...GH_ENV, program, ...args], {
    label: program,
    ...options,
  })
}

// ponytail: assumes a POSIX target (/usr/bin/env, sh -l); Windows targets need a cmd launcher.
// Returns { path } or { path: null, searched } when no candidate answers its probe.
async function resolveTool(host, target, name) {
  const key = `${name}|${target?.projectId ?? ''}`
  if (toolPaths.has(key)) {
    return { path: toolPaths.get(key) }
  }
  // The login shell's PATH sees Homebrew and user installs that a GUI-started app may miss.
  const shell = await runPlain(host, target, '/bin/sh', ['-lc', `command -v ${name}`])
  const fromShell = shell.ok
    ? cleanTerminalOutput(shell.output)
        .split('\n')
        .map(line => line.trim())
        .find(line => line.startsWith('/'))
    : undefined
  const tool = TOOLS[name]
  const searched = [...new Set([fromShell, ...tool.candidates()].filter(Boolean))]
  const found = await findSeries(searched, async candidate =>
    (await runPlain(host, target, candidate, tool.probe)).ok ? candidate : null,
  )
  if (found) {
    toolPaths.set(key, found)
  }
  return { path: found ?? null, searched }
}

// Runs a known tool (gh or opencove) by its resolved path, plain and non-interactive.
export async function runTool(host, target, name, args, options = {}) {
  const resolved = await resolveTool(host, target, name)
  if (!resolved.path) {
    return {
      ok: false,
      error:
        name === 'gh'
          ? classifyGhFailure({ status: 'failed', exitCode: 127 })
          : {
              code: TOOLS[name].missing,
              message: `The ${name} CLI was not found on the project machine (looked in: login shell PATH, ${resolved.searched.join(', ')}). Install it from Settings → Worker → CLI → Install CLI, check the file exists, then retry.`,
            },
    }
  }
  return runPlain(host, target, resolved.path, args, { label: name, ...options })
}

// Runs `gh <args>` with an explicit --repo (when given), no prompts, colours or pager.
export function runGh(host, target, args, { repo, ...options } = {}) {
  return runTool(host, target, 'gh', withRepo(args, repo), options)
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

// Any non-gh failure: always the exit code (or status) plus the first output lines, redacted.
export function describeFailure(
  label,
  { status = 'failed', exitCode = null, output = '', error = '' } = {},
) {
  const excerpt = outputExcerpt(`${String(output ?? '')}\n${String(error ?? '')}`)
  const reason =
    status === 'cancelled'
      ? `${label} was cancelled`
      : `${label} failed (exit ${exitCode ?? 'unknown'})`
  return { code: 'cli-failed', message: `${reason}: ${excerpt || '(no output)'}`.slice(0, 500) }
}

function messageOf(caught) {
  return caught instanceof Error ? caught.message : String(caught)
}
