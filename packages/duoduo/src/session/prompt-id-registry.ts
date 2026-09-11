/**
 * Per-session promptID registry.
 *
 * Maps sessionID → promptID so that tools (like edit.ts) can access
 * the current prompt's blackboard scope without threading promptID
 * through every function signature.
 *
 * Lifecycle: set in prompt() before runLoop, deleted on runLoop exit.
 */

const registry = new Map<string, string>()

export function setPromptID(sessionID: string, promptID: string): void {
  registry.set(sessionID, promptID)
}

export function getPromptID(sessionID: string): string | undefined {
  return registry.get(sessionID)
}

export function deletePromptID(sessionID: string): void {
  registry.delete(sessionID)
}
