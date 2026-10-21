// Structured command failures: a stable `code` the caller can branch on, plus optional details.
export function commandError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details })
}
