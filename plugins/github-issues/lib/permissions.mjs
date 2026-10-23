// Per-repository agent permission mode. Plugin modes map onto core modes for agentPermissionMode:
// normal -> default (approval per command), auto -> auto (classifier), full -> full (no prompts).
// Precedence for one repository: exact `owner/repo` line > `owner/*` line > legacy
// auto-approve-repos (counts as full) > normal. A malformed mode value fails closed to normal.
import { normalizeRepo, parseRepoList } from './trust.mjs'

export const PERMISSION_MODES = Object.freeze(['normal', 'auto', 'full'])
const CORE_MODE = Object.freeze({ normal: 'default', auto: 'auto', full: 'full' })
const WILDCARD = /^([A-Za-z0-9._-]+)\/\*$/

// Lines of `owner/repo: normal|auto|full` or `owner/*: mode`. Lines without a valid key are
// ignored; a valid key with an unknown mode is stored as normal (fail closed).
export function parsePermissionModes(text, legacyAutoApprove = '') {
  const exact = new Map()
  const wildcard = new Map()
  for (const line of String(text ?? '').split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) {
      continue
    }
    const key = line.slice(0, colon).trim()
    const wild = WILDCARD.exec(key)
    const repo = wild ? null : normalizeRepo(key)
    if (!wild && !repo) {
      continue
    }
    const raw = line
      .slice(colon + 1)
      .trim()
      .toLowerCase()
    const mode = PERMISSION_MODES.includes(raw) ? raw : 'normal'
    if (wild) {
      wildcard.set(wild[1].toLowerCase(), mode)
    } else {
      exact.set(repo, mode)
    }
  }
  return { exact, wildcard, legacy: parseRepoList(legacyAutoApprove) }
}

export function permissionModeFor(modes, repo) {
  const slug = normalizeRepo(repo)
  if (!slug) {
    return 'normal'
  }
  if (modes.exact.has(slug)) {
    return modes.exact.get(slug)
  }
  const owner = slug.split('/')[0]
  if (modes.wildcard.has(owner)) {
    return modes.wildcard.get(owner)
  }
  return modes.legacy.has(slug) ? 'full' : 'normal'
}

export function corePermissionMode(mode) {
  return CORE_MODE[mode] ?? CORE_MODE.normal
}

// max-agents: how many issue agents may run at once in one project. Lines of `owner/repo: N`,
// `owner/*: N` or `*: N`; precedence is exact line > owner wildcard > `*` > DEFAULT_MAX_AGENTS.
// A value that is not a whole number is ignored, so that line falls through to the next match.
export const DEFAULT_MAX_AGENTS = 2

export function parseMaxAgents(text) {
  const exact = new Map()
  const owners = new Map()
  let all = null
  for (const line of String(text ?? '').split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) {
      continue
    }
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (!/^\d{1,4}$/.test(value)) {
      continue
    }
    const limit = Number(value)
    const wild = WILDCARD.exec(key)
    const repo = normalizeRepo(key)
    if (key === '*') {
      all = limit
    } else if (wild) {
      owners.set(wild[1].toLowerCase(), limit)
    } else if (repo) {
      exact.set(repo, limit)
    }
  }
  return { exact, owners, all }
}

export function maxAgentsFor(limits, repo) {
  const slug = normalizeRepo(repo)
  if (slug && limits.exact.has(slug)) {
    return limits.exact.get(slug)
  }
  const owner = slug?.split('/')[0]
  if (owner && limits.owners.has(owner)) {
    return limits.owners.get(owner)
  }
  return limits.all ?? DEFAULT_MAX_AGENTS
}
