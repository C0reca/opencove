// Parameter validation shared by the coordinator commands. Every failure is a coded error.
import { commandError } from './errors.mjs'

export const MAX_TEXT_CHARS = 4000

export function requireProjectId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw commandError('invalid-params', 'projectId must be a non-empty string')
  }
  return value
}

export function requirePositiveInt(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw commandError('invalid-params', `${field} must be a positive integer`)
  }
  return value
}

// Required free text: trimmed, non-empty, bounded so it fits one gh argument comfortably.
export function requireText(value, field, max = MAX_TEXT_CHARS) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) {
    throw commandError('invalid-params', `${field} must be a non-empty string`)
  }
  if (text.length > max) {
    throw commandError('invalid-params', `${field} must be at most ${max} characters`)
  }
  return text
}

// Optional free text: absent means empty; a present value follows requireText rules.
export function optionalText(value, field, max = MAX_TEXT_CHARS) {
  if (value === undefined || value === null) {
    return ''
  }
  return requireText(value, field, max)
}
