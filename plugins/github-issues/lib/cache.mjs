export const DEFAULT_TTL_MS = 60_000

// In-memory TTL cache. Entries expire lazily on read; nothing runs in the background.
export function createTtlCache({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const entries = new Map()

  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) {
        return undefined
      }
      if (now() - entry.storedAt >= ttlMs) {
        entries.delete(key)
        return undefined
      }
      return entry.value
    },
    set(key, value) {
      entries.set(key, { value, storedAt: now() })
    },
    delete(key) {
      entries.delete(key)
    },
    clear() {
      entries.clear()
    },
  }
}
