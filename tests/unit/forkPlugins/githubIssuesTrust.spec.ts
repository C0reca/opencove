import { describe, expect, it } from 'vitest'
import {
  parseRepoList,
  parseTrustedAuthors,
  permissionDecision,
  readTrustPolicy,
  staticTrustReason,
} from '../../../plugins/github-issues/lib/trust.mjs'

describe('github-issues preferences', () => {
  it('parses trustedAuthors lines with whitespace and case tolerance', () => {
    const map = parseTrustedAuthors('  C0Reca/OpenCove :  Alice ,bob  \n*: Carol\n')

    expect(map.get('c0reca/opencove')).toEqual(new Set(['alice', 'bob']))
    expect(map.get('*')).toEqual(new Set(['carol']))
  })

  it('merges repeated lines for one repository and ignores malformed lines', () => {
    const map = parseTrustedAuthors('o/r: a\no/r: b\nno colon here\nnot-a-repo: x\n: y\n')

    expect(map.get('o/r')).toEqual(new Set(['a', 'b']))
    expect([...map.keys()]).toEqual(['o/r'])
  })

  it('parses the legacy auto-approve-repos list from commas and newlines', () => {
    expect(parseRepoList(' C0Reca/OpenCove, other/repo\nbad-entry\n')).toEqual(
      new Set(['c0reca/opencove', 'other/repo']),
    )
  })

  it('treats missing preferences as empty, with every repository in normal mode', () => {
    const policy = readTrustPolicy({})

    expect(policy.trustedAuthors.size).toBe(0)
    expect(policy.permissionModes.exact.size).toBe(0)
    expect(policy.permissionModes.wildcard.size).toBe(0)
    expect(policy.permissionModes.legacy.size).toBe(0)
  })
})

describe('github-issues author trust', () => {
  const none = new Map()
  const listed = parseTrustedAuthors('o/r: alice\n*: dave')

  it('trusts the repository owner, C0reca and listed authors without asking GitHub', () => {
    expect(staticTrustReason({ author: 'O', repo: 'o/r', trustedAuthors: none })).toEqual({
      trusted: true,
      reason: 'repo-owner',
    })
    expect(staticTrustReason({ author: 'c0reca', repo: 'x/y', trustedAuthors: none })).toEqual({
      trusted: true,
      reason: 'maintainer',
    })
    expect(staticTrustReason({ author: 'Alice', repo: 'O/R', trustedAuthors: listed })).toEqual({
      trusted: true,
      reason: 'listed',
    })
    expect(staticTrustReason({ author: 'dave', repo: 'x/y', trustedAuthors: listed })).toEqual({
      trusted: true,
      reason: 'listed',
    })
  })

  it('fails closed without an author or with a malformed repository', () => {
    expect(staticTrustReason({ author: null, repo: 'o/r', trustedAuthors: none })).toEqual({
      trusted: false,
      reason: 'no-author',
    })
    expect(staticTrustReason({ author: 'o', repo: 'bad', trustedAuthors: none })).toEqual({
      trusted: false,
      reason: 'unknown-repo',
    })
  })

  it('defers unlisted authors to the collaborator permission lookup', () => {
    expect(staticTrustReason({ author: 'mallory', repo: 'o/r', trustedAuthors: listed })).toBe(null)
  })

  it('trusts only write, maintain and admin collaborators', () => {
    expect(permissionDecision('admin')).toEqual({ trusted: true, reason: 'collaborator' })
    expect(permissionDecision('maintain')).toEqual({ trusted: true, reason: 'collaborator' })
    expect(permissionDecision(' Write ')).toEqual({ trusted: true, reason: 'collaborator' })
    expect(permissionDecision('read')).toEqual({
      trusted: false,
      reason: 'insufficient-permission',
    })
    expect(permissionDecision('none')).toEqual({
      trusted: false,
      reason: 'insufficient-permission',
    })
  })

  it('fails closed when the permission lookup failed', () => {
    expect(permissionDecision(null)).toEqual({ trusted: false, reason: 'permission-unknown' })
    expect(permissionDecision(undefined)).toEqual({
      trusted: false,
      reason: 'permission-unknown',
    })
  })
})
