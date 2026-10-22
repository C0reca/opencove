// Pure author-trust rules for issue.assign: preference parsing and the decision table.
// Fail closed: anything missing or unparsable leaves the author untrusted.
// The gh permission lookup itself lives in assign.mjs; permissionDecision only reads its answer.
import { parsePermissionModes } from './permissions.mjs'

export const MAINTAINER_LOGIN = 'c0reca'
export const TRUSTED_PERMISSIONS = Object.freeze(['admin', 'maintain', 'write'])

const SLUG = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/

export function normalizeLogin(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

// "Owner/Repo " -> "owner/repo", or null when the value is not a repository slug.
export function normalizeRepo(value) {
  const match = SLUG.exec(String(value ?? '').trim())
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null
}

// Comma- or newline-separated `owner/repo` list (autoApproveRepos).
export function parseRepoList(text) {
  const repos = new Set()
  for (const part of String(text ?? '').split(/[,\n]/)) {
    const repo = normalizeRepo(part)
    if (repo) {
      repos.add(repo)
    }
  }
  return repos
}

// Lines of `owner/repo: alice, bob` or `*: alice` -> Map<scope, Set<login>>.
// Malformed lines are ignored, which can only narrow trust.
export function parseTrustedAuthors(text) {
  const byScope = new Map()
  for (const line of String(text ?? '').split('\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) {
      continue
    }
    const key = line.slice(0, colon).trim()
    const scope = key === '*' ? '*' : normalizeRepo(key)
    if (!scope) {
      continue
    }
    const logins = byScope.get(scope) ?? new Set()
    for (const part of line.slice(colon + 1).split(',')) {
      const login = normalizeLogin(part)
      if (login) {
        logins.add(login)
      }
    }
    byScope.set(scope, logins)
  }
  return byScope
}

// Reads the trust and permission preferences from a snapshot; missing values mean empty.
export function readTrustPolicy(preferences) {
  return {
    trustedAuthors: parseTrustedAuthors(preferences?.['trusted-authors']),
    permissionModes: parsePermissionModes(
      preferences?.['permission-modes'],
      preferences?.['auto-approve-repos'],
    ),
  }
}

// Decides without GitHub when possible: returns { trusted, reason }, or null when the
// collaborator permission must be asked.
export function staticTrustReason({ author, repo, trustedAuthors }) {
  const login = normalizeLogin(author)
  if (!login) {
    return { trusted: false, reason: 'no-author' }
  }
  const slug = normalizeRepo(repo)
  if (!slug) {
    return { trusted: false, reason: 'unknown-repo' }
  }
  if (login === slug.split('/')[0]) {
    return { trusted: true, reason: 'repo-owner' }
  }
  if (login === MAINTAINER_LOGIN) {
    return { trusted: true, reason: 'maintainer' }
  }
  const listed = [...(trustedAuthors?.get(slug) ?? []), ...(trustedAuthors?.get('*') ?? [])]
  if (listed.includes(login)) {
    return { trusted: true, reason: 'listed' }
  }
  return null
}

// permission: the collaborator permission string, or null when the lookup failed.
export function permissionDecision(permission) {
  if (typeof permission !== 'string') {
    return { trusted: false, reason: 'permission-unknown' }
  }
  if (TRUSTED_PERMISSIONS.includes(permission.trim().toLowerCase())) {
    return { trusted: true, reason: 'collaborator' }
  }
  return { trusted: false, reason: 'insufficient-permission' }
}
