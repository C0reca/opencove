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
