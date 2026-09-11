import { chmod, copyFile, mkdir, readFile, rename, stat as statFile, unlink, writeFile } from "fs/promises"
import { createWriteStream, existsSync, statSync } from "fs"
import { realpathSync } from "fs"
import { dirname, join, relative, resolve as pathResolve, win32 } from "path"
import { Readable } from "stream"
import { pipeline } from "stream/promises"

// Fast sync version for metadata checks
export async function exists(p: string): Promise<boolean> {
  return existsSync(p)
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function stat(p: string): ReturnType<typeof statSync> | undefined {
  return statSync(p, { throwIfNoEntry: false }) ?? undefined
}

export async function statAsync(p: string): Promise<ReturnType<typeof statSync> | undefined> {
  return statFile(p).catch((e) => {
    if (isEnoent(e)) return undefined
    throw e
  })
}

export async function readText(p: string): Promise<string> {
  return readFile(p, "utf-8")
}

export async function readJson<T = unknown>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, "utf-8"))
}

export async function readBytes(p: string): Promise<Buffer> {
  return readFile(p)
}

export async function readArrayBuffer(p: string): Promise<ArrayBuffer> {
  const buf = await readFile(p)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

function isEnoent(e: unknown): e is { code: "ENOENT" } {
  return typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "ENOENT"
}

export async function write(p: string, content: string | Buffer | Uint8Array, mode?: number): Promise<void> {
  try {
    if (mode) {
      await writeFile(p, content, { mode })
    } else {
      await writeFile(p, content)
    }
  } catch (e) {
    if (isEnoent(e)) {
      await mkdir(dirname(p), { recursive: true })
      if (mode) {
        await writeFile(p, content, { mode })
      } else {
        await writeFile(p, content)
      }
      return
    }
    throw e
  }
}

export async function writeJson(p: string, data: unknown, mode?: number): Promise<void> {
  const content = JSON.stringify(data, null, 2)
  const dir = dirname(p)
  // Ensure parent directory exists
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
  // Write to temp file first, then atomically rename
  const tmpPath = join(dir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  try {
    if (mode) {
      await writeFile(tmpPath, content, { mode })
    } else {
      await writeFile(tmpPath, content)
    }
    // Atomic rename (same partition). On cross-device (EXDEV), fall back to copy+unlink
    try {
      await rename(tmpPath, p)
    } catch (e: any) {
      if (e?.code === "EXDEV") {
        await copyFile(tmpPath, p)
        await unlink(tmpPath).catch(() => {})
      } else {
        throw e
      }
    }
  } catch (e) {
    // Best-effort cleanup of temp file on failure
    await unlink(tmpPath).catch(() => {})
    throw e
  }
}

export async function writeStream(
  p: string,
  stream: ReadableStream<Uint8Array> | Readable,
  mode?: number,
): Promise<void> {
  const dir = dirname(p)
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }

  const nodeStream = stream instanceof ReadableStream ? Readable.fromWeb(stream as any) : stream
  const writeStream = createWriteStream(p)
  await pipeline(nodeStream, writeStream)

  if (mode) {
    await chmod(p, mode)
  }
}

export async function mimeType(p: string): Promise<string> {
  const { lookup } = await import("mime-types")
  return lookup(p) || "application/octet-stream"
}

// ── realpathSync LRU cache (aligned with @duoduo-ai/shared/filesystem P1 optimization) ──
// Same process lifecycle: paths don't change unless symlinks change.
// FileWatcher clears relevant entries on symlink directory changes.
const realpathCache = new Map<string, string>()

/**
 * On Windows, normalize a path to its canonical casing using the filesystem.
 * This is needed because Windows paths are case-insensitive but LSP servers
 * may return paths with different casing than what we send them.
 *
 * Uses the same realpathCache as resolve() to avoid redundant realpathSync calls.
 */
export function normalizePath(p: string): string {
  if (process.platform !== "win32") return p
  const resolved = win32.normalize(win32.resolve(windowsPath(p)))
  const cached = realpathCache.get(resolved)
  if (cached !== undefined) return cached
  try {
    const result = realpathSync.native(resolved)
    realpathCache.set(resolved, result)
    return result
  } catch {
    realpathCache.set(resolved, resolved)
    return resolved
  }
}

// We cannot rely on path.resolve() here because git.exe may come from Git Bash, Cygwin, or MSYS2, so we need to translate these paths at the boundary.
// Also resolves symlinks so that callers using the result as a cache key
// always get the same canonical path for a given physical directory.
export function resolve(p: string): string {
  const resolved = pathResolve(windowsPath(p))
  const cached = realpathCache.get(resolved)
  if (cached !== undefined) return cached
  try {
    const result = realpathSync.native(resolved) // single realpathSync call
    realpathCache.set(resolved, result)
    return result
  } catch (e) {
    if (isEnoent(e)) {
      realpathCache.set(resolved, resolved)
      return resolved
    }
    throw e
  }
}

export function windowsPath(p: string): string {
  if (process.platform !== "win32") return p
  return (
    p
      .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      // Git Bash for Windows paths are typically /<drive>/...
      .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      // Cygwin git paths are typically /cygdrive/<drive>/...
      .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      // WSL paths are typically /mnt/<drive>/...
      .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
  )
}
export function contains(parent: string, child: string) {
  const rel = relative(parent, child)
  // On Windows, relative() between paths on different drives returns an
  // absolute path (e.g. "D:\etc\passwd" when parent is on C:), which does
  // NOT start with "..". Treat any absolute result as outside — same
  // defense as @duoduo-ai/shared/filesystem.contains. Without this the
  // check wrongly reports cross-drive paths as contained.
  if (rel.startsWith("..")) return false
  if (pathResolve(rel) === rel) return false // absolute path means different root
  return true
}

export async function findUp(
  target: string,
  start: string,
  stop?: string,
  options?: { rootFirst?: boolean },
): Promise<string[]>
export async function findUp(
  target: string[],
  start: string,
  stop?: string,
  options?: { rootFirst?: boolean },
): Promise<string[]>
export async function findUp(
  target: string | string[],
  start: string,
  stop?: string,
  options?: { rootFirst?: boolean },
) {
  const dirs = [start]
  let current = start
  while (true) {
    if (stop === current) break
    const parent = dirname(current)
    if (parent === current) break
    dirs.push(parent)
    current = parent
  }

  const targets = Array.isArray(target) ? target : [target]
  const result = []
  for (const dir of options?.rootFirst ? dirs.toReversed() : dirs) {
    for (const item of targets) {
      const search = join(dir, item)
      if (await exists(search)) result.push(search)
    }
  }
  return result
}

export async function* up(options: { targets: string[]; start: string; stop?: string }) {
  const { targets, start, stop } = options
  let current = start
  while (true) {
    for (const target of targets) {
      const search = join(current, target)
      if (await exists(search)) yield search
    }
    if (stop === current) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}
