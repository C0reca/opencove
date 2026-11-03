// Per-repository limit on active issue agents (#60). Preference `max-agents`: one line per
// repository, `owner/repo: N`, plus `*: N` for every other repository. The exact line wins.
// A line that is not `key: non-negative integer` is ignored, so a typo falls back to `*` or the
// default rather than lifting the limit.
import { normalizeRepo } from './trust.mjs'

export const DEFAULT_MAX_AGENTS = 2

export function parseMaxAgents(text) {
  const exact = new Map()
  let fallback = DEFAULT_MAX_AGENTS
  for (const line of String(text ?? '').split('\n')) {
    const colon = line.indexOf(':')
    const raw = colon < 0 ? '' : line.slice(colon + 1).trim()
    if (!/^\d+$/.test(raw)) {
      continue
    }
    const key = line.slice(0, colon).trim()
    const value = Number(raw)
    if (key === '*') {
      fallback = value
    } else if (normalizeRepo(key)) {
      exact.set(normalizeRepo(key), value)
    }
  }
  return { exact, fallback }
}

export function maxAgentsFor(limits, repo) {
  return limits.exact.get(normalizeRepo(repo)) ?? limits.fallback
}

const LIVE_RUNTIME = new Set(['running', 'waiting', 'restoring'])

// One agents.status row. The observed agentState wins (the saved runtimeStatus can lag); a
// finished turn ('done') no longer holds a slot. Without an observation, a live runtime counts.
export function isActiveAgentRow(row) {
  if (!row.agentNodeId) {
    return false
  }
  if (row.agentState) {
    return row.agentState !== 'done'
  }
  return LIVE_RUNTIME.has(row.runtimeStatus)
}
