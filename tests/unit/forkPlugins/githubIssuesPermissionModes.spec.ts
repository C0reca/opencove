import { describe, expect, it } from 'vitest'
import {
  corePermissionMode,
  parsePermissionModes,
  permissionModeFor,
} from '../../../plugins/github-issues/lib/permissions.mjs'
import { readTrustPolicy } from '../../../plugins/github-issues/lib/trust.mjs'

const modesOf = (text: string, legacy = '') => parsePermissionModes(text, legacy)

describe('github-issues permission modes', () => {
  it('defaults every repository to normal', () => {
    expect(permissionModeFor(modesOf(''), 'C0reca/opencove')).toBe('normal')
  })

  it('reads exact lines for each mode, case-insensitively', () => {
    const modes = modesOf('C0Reca/OpenCove: AUTO\nother/repo: full\nthird/x: normal')

    expect(permissionModeFor(modes, 'c0reca/opencove')).toBe('auto')
    expect(permissionModeFor(modes, 'OTHER/repo')).toBe('full')
    expect(permissionModeFor(modes, 'third/x')).toBe('normal')
  })

  it('applies an owner wildcard to every repository of that owner', () => {
    const modes = modesOf('C0reca/*: auto')

    expect(permissionModeFor(modes, 'C0reca/opencove')).toBe('auto')
    expect(permissionModeFor(modes, 'c0reca/anything')).toBe('auto')
    expect(permissionModeFor(modes, 'someone/else')).toBe('normal')
  })

  it('lets the exact line win over the wildcard, in either order', () => {
    const first = modesOf('C0reca/*: auto\nC0reca/opencove: normal')
    const second = modesOf('C0reca/opencove: normal\nC0reca/*: full')

    expect(permissionModeFor(first, 'c0reca/opencove')).toBe('normal')
    expect(permissionModeFor(second, 'c0reca/opencove')).toBe('normal')
    expect(permissionModeFor(second, 'c0reca/other')).toBe('full')
  })

  it('migrates auto-approve-repos entries to full unless permission-modes sets them', () => {
    const migrated = modesOf('', 'c0reca/opencove, other/repo')

    expect(permissionModeFor(migrated, 'C0reca/OpenCove')).toBe('full')
    expect(permissionModeFor(migrated, 'other/repo')).toBe('full')
    expect(permissionModeFor(migrated, 'third/x')).toBe('normal')

    const overridden = modesOf(
      'c0reca/opencove: auto\nother/*: normal',
      'c0reca/opencove, other/repo',
    )
    expect(permissionModeFor(overridden, 'c0reca/opencove')).toBe('auto')
    expect(permissionModeFor(overridden, 'other/repo')).toBe('normal')
  })

  it('fails closed: an unknown mode value is normal, and malformed lines are ignored', () => {
    const modes = modesOf(
      'c0reca/opencove: turbo\nnot a repo: full\n: full\nno colon\n',
      'c0reca/opencove',
    )

    expect(permissionModeFor(modes, 'c0reca/opencove')).toBe('normal')
    expect(modes.exact.size).toBe(1)
    expect(modes.wildcard.size).toBe(0)
  })

  it('maps plugin modes onto the core agentPermissionMode values', () => {
    expect(corePermissionMode('normal')).toBe('default')
    expect(corePermissionMode('auto')).toBe('auto')
    expect(corePermissionMode('full')).toBe('full')
    expect(corePermissionMode('unknown')).toBe('default')
  })

  it('reads the policy from preferences, including the migration', () => {
    const policy = readTrustPolicy({
      'permission-modes': 'c0reca/*: auto',
      'auto-approve-repos': 'other/repo',
    })

    expect(permissionModeFor(policy.permissionModes, 'c0reca/opencove')).toBe('auto')
    expect(permissionModeFor(policy.permissionModes, 'other/repo')).toBe('full')
  })
})
