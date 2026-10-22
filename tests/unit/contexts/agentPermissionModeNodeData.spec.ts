import { describe, expect, it } from 'vitest'
import { normalizeCreateNodeData } from '../../../src/contexts/workspace/application/nodeControl/nodeDataFactory'

const agentBase = { prompt: 'hi', provider: 'codex', model: null }

// AppError keeps the user-facing message generic; the detail lives in debugMessage.
function debugMessageOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return (error as { debugMessage?: string }).debugMessage ?? ''
  }
  return ''
}

describe('normalizeCreateNodeData agent permission mode', () => {
  it.each(['default', 'auto', 'full'] as const)('accepts agentPermissionMode=%s', mode => {
    expect(
      normalizeCreateNodeData('agent', { ...agentBase, agentPermissionMode: mode }),
    ).toMatchObject({ kind: 'agent', agentPermissionMode: mode })
  })

  it('maps the agentFullAccess alias to full or default with the same result as the mode', () => {
    expect(normalizeCreateNodeData('agent', { ...agentBase, agentFullAccess: true })).toEqual(
      normalizeCreateNodeData('agent', { ...agentBase, agentPermissionMode: 'full' }),
    )
    expect(normalizeCreateNodeData('agent', { ...agentBase, agentFullAccess: false })).toEqual(
      normalizeCreateNodeData('agent', { ...agentBase, agentPermissionMode: 'default' }),
    )
  })

  it('leaves the mode absent when neither field is sent', () => {
    expect(normalizeCreateNodeData('agent', agentBase)).not.toHaveProperty('agentPermissionMode')
  })

  it('rejects sending both fields with common.invalid_input', () => {
    expect(
      debugMessageOf(() =>
        normalizeCreateNodeData('agent', {
          ...agentBase,
          agentPermissionMode: 'auto',
          agentFullAccess: true,
        }),
      ),
    ).toMatch(/either agentPermissionMode or agentFullAccess/)
  })

  it.each(['bypass', '', 1, null])('rejects an invalid agentPermissionMode=%j', value => {
    expect(
      debugMessageOf(() =>
        normalizeCreateNodeData('agent', { ...agentBase, agentPermissionMode: value }),
      ),
    ).toMatch(/agentPermissionMode must be one of/)
  })
})
