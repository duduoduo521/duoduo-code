/**
 * Module-level cascadeQA registry + session-deletion callback hub,
 * extracted from prompt.ts to avoid a circular dependency between
 * session.ts ↔ prompt.ts.
 *
 * prompt.ts → session.ts (for Session types)
 * session.ts → cascade-qa-registry.ts (for triggerOnDelete)
 * prompt.ts → cascade-qa-registry.ts (for getCascadeQA / setCascadeQA / onSessionDeleted)
 *
 * No cycle.
 */

const cascadeQARegistry = new Map<string, boolean>()
let cascadeQADefault: boolean | undefined = undefined

/**
 * Callbacks to invoke when a session is deleted, registered by other modules
 * (e.g. prompt.ts) without creating a circular dependency. session.ts calls
 * triggerOnDelete from Session.remove — it does NOT import from prompt.ts.
 */
const onDeleteCallbacks = new Set<(sessionID: string) => void>()

export function onSessionDeleted(callback: (sessionID: string) => void) {
  onDeleteCallbacks.add(callback)
}

export function triggerOnDelete(sessionID: string) {
  for (const cb of onDeleteCallbacks) {
    cb(sessionID)
  }
}

export function setCascadeQA(sessionID: string, value: boolean) {
  // Per-session override (cascadeQA is deprecated in favor of the
  // "语法校验"/"审校" switches, but the per-session setting still works).
  cascadeQARegistry.set(sessionID, value)
}

export function setCascadeQAGlobal(value: boolean) {
  // Only update the default applied to NEW sessions. Do NOT retroactively
  // overwrite already-registered sessions (fixes §1.1 #8 global-pollution
  // side effect — changing a setting must not affect sessions already in flight).
  cascadeQADefault = value
}

export function deleteCascadeQA(sessionID: string) {
  cascadeQARegistry.delete(sessionID)
}

export function getCascadeQA(sessionID: string): boolean {
  if (cascadeQARegistry.has(sessionID)) return cascadeQARegistry.get(sessionID)!
  return cascadeQADefault ?? false
}
