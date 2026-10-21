import { classifyGhFailure } from './gh.mjs'
import { commandError } from './errors.mjs'

const TERMINAL = new Set(['completed', 'cancelled', 'failed'])
const POLL_MS = 500
const TIMEOUT_MS = 60_000

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// Runs `gh <args>` in the target project's directory through the host, which routes to its mount.
// Args are passed as an array, never as a shell string.
// Resolves to { ok: true, output } or { ok: false, error: { code, message } }.
export async function runGh(host, target, args, { timeoutMs = TIMEOUT_MS, pollMs = POLL_MS } = {}) {
  let handle
  try {
    handle = await host.operations.start({ target, command: 'gh', args, timeoutMs })
  } catch (caught) {
    return { ok: false, error: classifyGhFailure({ status: 'failed', error: messageOf(caught) }) }
  }

  const settled = await pollUntilSettled(host, handle.operationId, {
    deadline: Date.now() + timeoutMs + 5_000,
    pollMs,
  })
  if (!settled) {
    await host.operations.cancel({ operationId: handle.operationId }).catch(() => undefined)
    return { ok: false, error: { code: 'gh-failed', message: 'gh timed out' } }
  }

  if (settled.status === 'completed' && settled.exitCode === 0) {
    return { ok: true, output: settled.output ?? '' }
  }
  return {
    ok: false,
    error: classifyGhFailure({
      status: settled.status,
      exitCode: settled.exitCode,
      output: settled.output,
      error: settled.error,
    }),
  }
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
