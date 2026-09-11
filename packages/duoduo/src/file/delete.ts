import * as path from "path"
import { Effect } from "effect"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import * as Process from "@/util/process"
import { Log } from "@/util"

const log = Log.create({ service: "file.delete" })

// Hard-delete pacing. Antivirus ransomware shields trigger on bursts of file
// removals from a single unknown process, so a bulk recursive unlink is split
// into chunks with a pause between them. The budget caps the extra latency one
// request can add, and small trees are not paced at all (they never trip the
// heuristic and pacing would only slow down everyday deletes).
export const PACING_SMALL_TREE = 200
export const PACING_CHUNK = 100
export const PACING_PAUSE_MS = 200
export const PACING_BUDGET_MS = 10_000

export interface DeleteResult {
  /** True when the path was moved to the OS recycle bin instead of unlinked. */
  readonly recycled: boolean
}

function powershellLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Move `target` to the recycle bin through the Windows Shell API, executed by
 * powershell.exe (a signed system binary) rather than this process. Returns
 * false — never fails — when unavailable or rejected, so callers can fall back.
 */
export const recycle = (target: string, isDirectory: boolean): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: async () => {
      const method = isDirectory ? "DeleteDirectory" : "DeleteFile"
      const script =
        `$global:ProgressPreference = 'SilentlyContinue'; ` +
        `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
        `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}(` +
        `${powershellLiteral(target)},'OnlyErrorDialogs','SendToRecycleBin')`
      const out = await Process.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], {
        nothrow: true,
      })
      if (out.code !== 0) {
        log.warn("Recycle-bin delete rejected, falling back to hard delete", {
          target,
          code: out.code,
          stderr: out.stderr.toString().trim(),
        })
        return false
      }
      return true
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) => {
      log.warn("Recycle-bin delete failed to launch, falling back to hard delete", { target, cause })
      return Effect.succeed(false)
    }),
  )

/**
 * Recursively remove `root` one entry at a time, paced so the unlink rate stays
 * below antivirus burst thresholds. Directories are removed deepest-first after
 * all files are gone; symlinks are unlinked, never followed.
 */
export function removeBatched(
  fs: AppFileSystem.Interface,
  root: string,
): Effect.Effect<void, AppFileSystem.Error> {
  return Effect.gen(function* () {
    const files: string[] = []
    const dirs: string[] = []
    const queue: string[] = [root]

    while (queue.length > 0) {
      const current = queue.pop()!
      const entries = yield* fs
        .readDirectoryEntries(current)
        .pipe(Effect.catch(() => Effect.succeed<AppFileSystem.DirEntry[]>([])))
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        if (entry.type === "directory") {
          dirs.push(full)
          queue.push(full)
          continue
        }
        files.push(full)
      }
    }

    let paced = 0
    for (let i = 0; i < files.length; i++) {
      yield* fs.remove(files[i]!)
      if (files.length <= PACING_SMALL_TREE) continue
      if ((i + 1) % PACING_CHUNK !== 0) continue
      if (paced >= PACING_BUDGET_MS) continue
      yield* Effect.sleep(`${PACING_PAUSE_MS} millis`)
      paced += PACING_PAUSE_MS
    }

    // Longer paths are deeper, so this removes children before parents.
    // `recursive: true` is required: Bun's non-recursive rm on a directory
    // fails with EFAULT on Windows. Directories are empty by this point, so
    // recursing here touches nothing that was not already paced.
    for (const dir of dirs.sort((a, b) => b.length - a.length)) {
      yield* fs.remove(dir, { recursive: true })
    }
    yield* fs.remove(root, { recursive: true })
  })
}

/**
 * Delete `target`, preferring the recycle bin on Windows and falling back to a
 * paced hard delete when the shell API is unavailable or refuses the path.
 */
export function remove(
  fs: AppFileSystem.Interface,
  target: string,
  isDirectory: boolean,
): Effect.Effect<DeleteResult, AppFileSystem.Error> {
  return Effect.gen(function* () {
    if (process.platform === "win32" && (yield* recycle(target, isDirectory))) {
      if (!(yield* fs.existsSafe(target))) return { recycled: true }
      log.warn("Recycle-bin delete reported success but path still exists", { target })
    }

    if (!isDirectory) {
      yield* fs.remove(target)
      return { recycled: false }
    }

    yield* removeBatched(fs, target)
    return { recycled: false }
  })
}
