import { describe, expect, it } from 'vitest'
import {
  isAgentPermissionMode,
  resolveAgentPermissionMode,
} from '../../../src/shared/utils/agentPermissionMode'

describe('resolveAgentPermissionMode', () => {
  it('prefers the persisted agentPermissionMode over legacy agentFullAccess and global', () => {
    expect(
      resolveAgentPermissionMode({ agentPermissionMode: 'auto', agentFullAccess: true }, true),
    ).toBe('auto')
    expect(
      resolveAgentPermissionMode({ agentPermissionMode: 'default', agentFullAccess: true }, true),
    ).toBe('default')
  })

  it('falls back to legacy agentFullAccess before the global setting', () => {
    expect(resolveAgentPermissionMode({ agentFullAccess: true }, false)).toBe('full')
    expect(resolveAgentPermissionMode({ agentFullAccess: false }, true)).toBe('default')
  })

  it('follows the global setting when nothing explicit is present', () => {
    expect(resolveAgentPermissionMode({}, true)).toBe('full')
    expect(resolveAgentPermissionMode(null, false)).toBe('default')
    expect(resolveAgentPermissionMode(undefined, true)).toBe('full')
  })

  it('treats null fields as absent', () => {
    expect(
      resolveAgentPermissionMode({ agentPermissionMode: null, agentFullAccess: null }, false),
    ).toBe('default')
  })
})

describe('isAgentPermissionMode', () => {
  it('accepts only the three modes', () => {
    expect(isAgentPermissionMode('default')).toBe(true)
    expect(isAgentPermissionMode('auto')).toBe(true)
    expect(isAgentPermissionMode('full')).toBe(true)
    expect(isAgentPermissionMode('bypass')).toBe(false)
    expect(isAgentPermissionMode(true)).toBe(false)
    expect(isAgentPermissionMode(undefined)).toBe(false)
  })
})
