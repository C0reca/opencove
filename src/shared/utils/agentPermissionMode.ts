import type { AgentPermissionMode } from '@shared/contracts/dto'
import { createAppError } from '@shared/errors/appError'

/** Fields that can carry a permission choice: the mode, or the legacy boolean alias. */
export interface AgentPermissionModeFields {
  agentPermissionMode?: unknown
  agentFullAccess?: unknown
}

export const AGENT_PERMISSION_MODES: readonly AgentPermissionMode[] = ['default', 'auto', 'full']

export function isAgentPermissionMode(value: unknown): value is AgentPermissionMode {
  return typeof value === 'string' && (AGENT_PERMISSION_MODES as readonly string[]).includes(value)
}

/**
 * Single resolution point for launch, relaunch and resume.
 * Precedence: node/payload agentPermissionMode, then legacy agentFullAccess, then the global setting.
 * Invalid or null values count as absent.
 */
export function resolveAgentPermissionMode(
  fields: AgentPermissionModeFields | null | undefined,
  globalFullAccess: boolean,
): AgentPermissionMode {
  if (isAgentPermissionMode(fields?.agentPermissionMode)) {
    return fields.agentPermissionMode
  }
  if (typeof fields?.agentFullAccess === 'boolean') {
    return fields.agentFullAccess ? 'full' : 'default'
  }
  return globalFullAccess ? 'full' : 'default'
}

/**
 * Validates the permission fields of an incoming payload (node.create data, agent or session launch).
 * Sending both fields is invalid. By default null means "not sent" (session and agent payloads);
 * node.create passes nullIsAbsent: false so an explicit null is rejected, as agentFullAccess always was.
 */
export function readAgentPermissionInput(
  record: AgentPermissionModeFields,
  label: string,
  options: { nullIsAbsent?: boolean } = {},
): { agentPermissionMode?: AgentPermissionMode } {
  const nullIsAbsent = options.nullIsAbsent ?? true
  const isSent = (value: unknown): boolean =>
    value !== undefined && !(nullIsAbsent && value === null)
  const hasMode = isSent(record.agentPermissionMode)
  const hasFullAccess = isSent(record.agentFullAccess)

  if (hasMode && hasFullAccess) {
    throw createAppError('common.invalid_input', {
      debugMessage: `${label} accepts either agentPermissionMode or agentFullAccess, not both.`,
    })
  }
  if (hasMode) {
    if (!isAgentPermissionMode(record.agentPermissionMode)) {
      throw createAppError('common.invalid_input', {
        debugMessage: `${label} agentPermissionMode must be one of default, auto, full.`,
      })
    }
    return { agentPermissionMode: record.agentPermissionMode }
  }
  if (hasFullAccess) {
    if (typeof record.agentFullAccess !== 'boolean') {
      throw createAppError('common.invalid_input', {
        debugMessage: `${label} agentFullAccess must be a boolean.`,
      })
    }
    return { agentPermissionMode: record.agentFullAccess ? 'full' : 'default' }
  }
  return {}
}

/**
 * Reads the permission fields of a persisted agent node tolerantly: invalid values are dropped,
 * so legacy and partially written data still loads. Validation of the shape is done separately.
 */
export function readPersistedAgentPermissionFields(record: Record<string, unknown>): {
  agentPermissionMode?: AgentPermissionMode
  agentFullAccess?: boolean
} {
  return {
    ...(isAgentPermissionMode(record.agentPermissionMode)
      ? { agentPermissionMode: record.agentPermissionMode }
      : {}),
    ...(typeof record.agentFullAccess === 'boolean'
      ? { agentFullAccess: record.agentFullAccess }
      : {}),
  }
}
