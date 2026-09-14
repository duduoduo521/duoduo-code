import path from "path"
import { existsSync, realpathSync } from "fs"
import { Instance } from "@/project/instance"

/**
 * SEC-02: mitigate the symlink TOCTOU between a file tool's path-scope check
 * and the actual file operation.
 *
 * An agent passes a path string; the tool first checks that it is allowed
 * (scope / external-directory) and only later opens it. If an attacker swaps
 * a component of that path for a symlink in the window between the two steps,
 * the operation can land outside the intended scope.
 *
 * This resolves the path (following symlinks) to its canonical on-disk
 * location and returns that single, stable path so the check and the fs op
 * act on the *same* target. Operating on the resolved path also neutralizes a
 * mid-flight symlink swap: the operation no longer touches the symlink, only
 * its already-resolved target.
 *
 * Boundary enforcement deliberately does NOT happen here: a path resolving
 * outside the project roots is a legitimate candidate for the
 * `assertExternalDirectoryEffect` permission prompt (deny / allow / always
 * allow), so throwing here would silently bypass that flow. Callers must run
 * `assertExternalDirectoryEffect` on the returned path — it decides via
 * `Instance.containsPath` (project dir, worktree, and the user-approved
 * `allowedPaths`), the same boundary the bash scan uses.
 */
export function resolveSafePath(input: string): string {
  const base = path.isAbsolute(input) ? input : path.join(Instance.directory, input)
  const dir = path.dirname(base)
  const resolvedDir = existsSync(dir) ? realpathSync(dir) : dir
  const resolved = existsSync(base) ? realpathSync(base) : path.join(resolvedDir, path.basename(base))
  return resolved
}
