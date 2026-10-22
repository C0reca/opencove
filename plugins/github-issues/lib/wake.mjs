// Wake-up service: tells the running issue coordinator when one of its issue agents starts
// waiting for the human or finishes. The coordinator works in turns and nothing else wakes it.
//
// Mechanism: a bounded backend timer, not host.events. host.events samples project, Space, node,
// session and preference changes. An agent's observed state (agents.get().agentState) is not an
// event type, so a working -> waiting change can happen with no indication. The timer reads
// agents.status only for projects with a running coordinator, and it stops in dispose().
import { findRunningCoordinator } from './coordinator.mjs'
import { mapSeries } from './sequence.mjs'
import { collectAgentStatus } from './status.mjs'

export const WAKE_PREFIX = '[github-issues]'
export const WAKE_PREFERENCE = 'coordinator-wake'
// Ceiling: a 10 s timer, one agents.status pass per project with a coordinator.
export const TICK_MS = 10_000
// Transitions must be quiet this long before one message goes out, so bursts coalesce.
export const SETTLE_MS = 5_000
// Pause between the text write and the Enter write (Claude Code's paste protection).
export const SUBMIT_DELAY_MS = 1_500
// After a wake, wait this long for the coordinator to react before sending the next one.
export const HOLD_MS = 120_000

const WAKE_STATES = new Set(['waiting', 'done'])

// One line, no newline, so the terminal never treats it as a multi-line paste.
export function wakeMessage(entries) {
  const clauses = entries.map(entry =>
    entry.state === 'done' ? `${entry.label} agent is done` : `${entry.label} agent is now waiting`,
  )
  const waiting = entries.filter(entry => entry.state === 'waiting').length
  const done = entries.length - waiting
  const tails = []
  if (waiting > 0) {
    tails.push(
      `Read ${waiting === 1 ? 'it' : 'each waiting agent'} with agents.read and tell the human what it asks.`,
    )
  }
  if (done > 0) {
    tails.push('Run your next loop.')
  }
  return `${WAKE_PREFIX} ${clauses.join('; ')}. ${tails.join(' ')}`
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// Per-project memory. `last` is the last observed state per issue; `pending` holds transitions not
// yet sent; `notified` keys sent transitions by issue + state + observedAt, so none repeats.
function newProjectState() {
  return {
    seeded: false,
    last: new Map(),
    pending: new Map(),
    notified: new Set(),
    lastChangeAt: 0,
    awaitingReaction: false,
    reactionBaseline: null,
    holdUntil: 0,
  }
}

export function createWakeService({
  host,
  projectIds,
  log = () => undefined,
  now = () => Date.now(),
  sleep = delay,
  tickMs = TICK_MS,
  settleMs = SETTLE_MS,
  submitDelayMs = SUBMIT_DELAY_MS,
  holdMs = HOLD_MS,
}) {
  const projects = new Map()
  let timer = null
  let disposed = false
  let inFlight = null

  // One pass at a time: a slow pass is not overlapped by the next tick.
  function tick() {
    if (disposed) {
      return Promise.resolve()
    }
    if (!inFlight) {
      inFlight = runPass()
        .catch(caught => log(`wake pass failed: ${messageOf(caught)}`))
        .finally(() => {
          inFlight = null
        })
    }
    return inFlight
  }

  function start() {
    if (timer || disposed) {
      return
    }
    timer = setInterval(() => {
      tick()
    }, tickMs)
    timer.unref?.()
  }

  async function dispose() {
    disposed = true
    clearInterval(timer)
    timer = null
    projects.clear()
    await inFlight
  }

  async function runPass() {
    const preferences = (await host.preferences.get()) ?? {}
    const enabled = preferences[WAKE_PREFERENCE] !== false
    await mapSeries(await projectIds(), async projectId => {
      if (disposed) {
        return
      }
      if (!enabled) {
        projects.delete(projectId)
        return
      }
      await checkProject(projectId)
    })
  }

  async function checkProject(projectId) {
    let coordinator
    try {
      coordinator = await findRunningCoordinator(host, projectId)
    } catch (caught) {
      // Unknown is not "stopped": keep the state and try again on the next tick.
      log(`wake: coordinator lookup failed for ${projectId}: ${messageOf(caught)}`)
      return
    }
    if (!coordinator) {
      projects.delete(projectId)
      return
    }

    const entry = projects.get(projectId) ?? newProjectState()
    projects.set(projectId, entry)
    const rows = await collectAgentStatus(host, [projectId])
    observe(entry, rows)
    if (!entry.seeded) {
      // The first look is a silent baseline: states that existed before are not replayed.
      entry.seeded = true
      return
    }
    await flush(entry, coordinator)
  }

  // Records each issue agent's observed state and queues the transitions into done or waiting.
  function observe(entry, rows) {
    for (const row of rows) {
      if (!row.agentState) {
        continue
      }
      const previous = entry.last.get(row.issue)
      entry.last.set(row.issue, row.agentState)
      const key = `${row.issue}|${row.agentState}|${row.agentStateObservedAt}`
      if (
        !entry.seeded ||
        previous === row.agentState ||
        !WAKE_STATES.has(row.agentState) ||
        entry.notified.has(key)
      ) {
        continue
      }
      entry.pending.set(row.issue, {
        issue: row.issue,
        label: `#${row.number}`,
        state: row.agentState,
        key,
      })
      entry.lastChangeAt = now()
    }
  }

  async function flush(entry, coordinator) {
    if (entry.pending.size === 0) {
      return
    }
    // After a wake, the coordinator's observation must change before another one goes out. A
    // stale "waiting" right after our write would otherwise be read as a reason to write again.
    if (entry.awaitingReaction) {
      const reacted = coordinator.observedAt !== entry.reactionBaseline
      if (!reacted && now() < entry.holdUntil) {
        return
      }
      entry.awaitingReaction = false
    }
    if (!WAKE_STATES.has(coordinator.state)) {
      return
    }
    if (now() - entry.lastChangeAt < settleMs) {
      return
    }

    // A transition is only sent while the issue still shows that state.
    for (const item of [...entry.pending.values()]) {
      if (entry.last.get(item.issue) !== item.state) {
        entry.pending.delete(item.issue)
      }
    }
    const items = [...entry.pending.values()]
    if (items.length === 0) {
      return
    }

    const nodeId = coordinator.node.id
    const baseline = coordinator.observedAt
    try {
      await host.agents.write({ nodeId, data: wakeMessage(items) })
    } catch (caught) {
      // Nothing was typed in, so the transitions stay queued for the next pass.
      log(`wake: text write failed: ${messageOf(caught)}`)
      return
    }
    await sleep(submitDelayMs)
    try {
      await host.agents.write({ nodeId, data: '\r' })
    } catch (caught) {
      // The text may now sit unsent in the coordinator's input. Do not resend it, so it is not doubled.
      log(`wake: Enter write failed; the message may need submitting by hand: ${messageOf(caught)}`)
    }
    for (const item of items) {
      entry.notified.add(item.key)
      entry.pending.delete(item.issue)
    }
    entry.awaitingReaction = true
    entry.reactionBaseline = baseline
    entry.holdUntil = now() + holdMs
  }

  return { start, tick, dispose }
}

function messageOf(caught) {
  return caught instanceof Error ? caught.message : String(caught)
}
