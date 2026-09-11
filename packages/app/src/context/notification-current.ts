import { workspaceKey } from "@/pages/layout/helpers"

/**
 * Decide whether a notification for `directory`/`sessionID` should be marked
 * "viewed" given the currently open directory/session.
 *
 * Compares via `workspaceKey` (not exact string equality) so that path variants
 * that refer to the same workspace — e.g. trailing slashes (`/a/b` vs `/a/b/`)
 * or Windows drive-letter casing (`c:/proj` vs `C:/proj`) — are treated as the
 * same project. Without this, notifications from the same workspace could be
 * incorrectly left "unseen" (problem 7).
 */
export function isViewedInCurrentSession(input: {
  directory: string
  sessionID?: string
  activeDirectory: string | undefined
  activeSession: string | undefined
}): boolean {
  if (!input.activeDirectory) return false
  if (!input.activeSession) return false
  if (!input.sessionID) return false
  if (workspaceKey(input.directory) !== workspaceKey(input.activeDirectory)) return false
  return input.sessionID === input.activeSession
}
