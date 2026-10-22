// Local-only autonomy. auto and full need the PreToolUse guard hook, and that hook runs the Worker's
// process.execPath and the installed plugin path. Those paths do not exist on a remote target, and
// Claude Code treats a failing hook as allow, so the guard would fail open there. auto and full
// therefore apply only to a local target; every other launch runs in normal.
// Locality comes from host.target.resolve. A local mount reports endpointId 'local'
// (LOCAL_WORKER_ENDPOINT in src/contexts/project/domain/workerEndpoint.ts); remote endpoints have
// opaque registry ids. A failed or incomplete lookup is unknown, and unknown counts as remote.
const AUTONOMOUS = Object.freeze(['auto', 'full'])
const LOCAL_ENDPOINT_ID = 'local'

// Returns 'local', 'remote' or 'unknown'.
export async function targetLocality(host, target) {
  let resolved
  try {
    resolved = await host.target.resolve(target)
  } catch {
    return 'unknown'
  }
  if (resolved?.endpointId === LOCAL_ENDPOINT_ID) {
    return 'local'
  }
  if (typeof resolved?.endpointId === 'string' && resolved.endpointId.length > 0) {
    return 'remote'
  }
  return 'unknown'
}

// One launch decision. reason is null when the configured mode runs as configured, otherwise
// 'remote-target' or 'unknown-target' (fail closed). normal is never resolved, so it costs no lookup.
export async function effectiveModeFor(host, target, configuredMode) {
  if (!AUTONOMOUS.includes(configuredMode)) {
    return { configuredMode, effectiveMode: configuredMode, reason: null }
  }
  const locality = await targetLocality(host, target)
  if (locality === 'local') {
    return { configuredMode, effectiveMode: configuredMode, reason: null }
  }
  return {
    configuredMode,
    effectiveMode: 'normal',
    reason: locality === 'remote' ? 'remote-target' : 'unknown-target',
  }
}
