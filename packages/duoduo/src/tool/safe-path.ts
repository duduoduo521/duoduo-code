import path from "path"
import { existsSync, realpathSync } from "fs"
import { Instance } from "@/project/instance"
import { DuoduoError } from "@/util/error"

function isWithin(child: string, root: string): boolean {
  const r = path.resolve(root)
  const c = path.resolve(child)
  return c === r || c.startsWith(r + path.sep)
}

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
 * its already-resolved target. Paths that resolve outside the project roots
 * are refused (fail-closed).
 */
export function resolveSafePath(input: string): string {
  const base = path.isAbsolute(input) ? input : path.join(Instance.directory, input)
  const dir = path.dirname(base)
  const resolvedDir = existsSync(dir) ? realpathSync(dir) : dir
  const resolved = existsSync(base) ? realpathSync(base) : path.join(resolvedDir, path.basename(base))

  const roots = [Instance.directory, Instance.worktree].filter(Boolean) as string[]
  if (!roots.some((root) => isWithin(resolved, root))) {
    throw new DuoduoError({
      message: `Path "${input}" resolves outside the project directory`,
      messageZh: `路径 "${input}" 解析到了项目目录之外`,
      cause: undefined,
    })
  }
  return resolved
}
