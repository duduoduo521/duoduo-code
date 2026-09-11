import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect"
import { registerDisposer } from "@/effect/instance-registry"

import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { Flag } from "@/flag/flag"
import { Git } from "@/git"
import { Effect, Layer, Context, Scope } from "effect"
import * as Stream from "effect/Stream"
import { formatPatch, structuredPatch } from "diff"
import fuzzysort from "fuzzysort"
import ignore from "ignore"
import path from "path"
import z from "zod"
import { Global } from "../global"
import { Instance } from "../project/instance"
import { Log } from "../util"
import { Protected } from "./protected"
import { Ripgrep } from "./ripgrep"

export const Info = z
  .object({
    path: z.string(),
    added: z.number().int(),
    removed: z.number().int(),
    status: z.enum(["added", "deleted", "modified"]),
  })
  .meta({
    ref: "File",
  })

export type Info = z.infer<typeof Info>

export const Node = z
  .object({
    name: z.string(),
    path: z.string(),
    absolute: z.string(),
    type: z.enum(["file", "directory"]),
    ignored: z.boolean(),
  })
  .meta({
    ref: "FileNode",
  })
export type Node = z.infer<typeof Node>

export const Content = z
  .object({
    type: z.enum(["text", "binary"]),
    content: z.string(),
    diff: z.string().optional(),
    patch: z
      .object({
        oldFileName: z.string(),
        newFileName: z.string(),
        oldHeader: z.string().optional(),
        newHeader: z.string().optional(),
        hunks: z.array(
          z.object({
            oldStart: z.number(),
            oldLines: z.number(),
            newStart: z.number(),
            newLines: z.number(),
            lines: z.array(z.string()),
          }),
        ),
        index: z.string().optional(),
      })
      .optional(),
    encoding: z.literal("base64").optional(),
    mimeType: z.string().optional(),
  })
  .meta({
    ref: "FileContent",
  })
export type Content = z.infer<typeof Content>

export const DiffContent = z
  .object({
    diff: z.string(),
    patch: z.object({
      oldFileName: z.string(),
      newFileName: z.string(),
      oldHeader: z.string().optional(),
      newHeader: z.string().optional(),
      hunks: z.array(
        z.object({
          oldStart: z.number(),
          oldLines: z.number(),
          newStart: z.number(),
          newLines: z.number(),
          lines: z.array(z.string()),
        }),
      ),
      index: z.string().optional(),
    }),
    original: z.string(),
  })
  .nullable()
  .meta({
    ref: "FileDiffContent",
  })
export type DiffContent = z.infer<typeof DiffContent>

export const Event = {
  Edited: BusEvent.define(
    "file.edited",
    z.object({
      file: z.string(),
    }),
  ),
}

const log = Log.create({ service: "file" })

const binary = new Set([
  "exe",
  "dll",
  "pdb",
  "bin",
  "so",
  "dylib",
  "o",
  "a",
  "lib",
  "wav",
  "mp3",
  "ogg",
  "oga",
  "ogv",
  "ogx",
  "flac",
  "aac",
  "wma",
  "m4a",
  "weba",
  "mp4",
  "avi",
  "mov",
  "wmv",
  "flv",
  "webm",
  "mkv",
  "zip",
  "tar",
  "gz",
  "gzip",
  "bz",
  "bz2",
  "bzip",
  "bzip2",
  "7z",
  "rar",
  "xz",
  "lz",
  "z",
  "pdf",
  "doc",
  "docx",
  "ppt",
  "pptx",
  "xls",
  "xlsx",
  "dmg",
  "iso",
  "img",
  "vmdk",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  "sqlite",
  "db",
  "mdb",
  "apk",
  "ipa",
  "aab",
  "xapk",
  "app",
  "pkg",
  "deb",
  "rpm",
  "snap",
  "flatpak",
  "appimage",
  "msi",
  "msp",
  "jar",
  "war",
  "ear",
  "class",
  "kotlin_module",
  "dex",
  "vdex",
  "odex",
  "oat",
  "art",
  "wasm",
  "wat",
  "bc",
  "ll",
  "s",
  "ko",
  "sys",
  "drv",
  "efi",
  "rom",
  "com",
])

const image = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "webp",
  "ico",
  "tif",
  "tiff",
  "svg",
  "svgz",
  "avif",
  "apng",
  "jxl",
  "heic",
  "heif",
  "raw",
  "cr2",
  "nef",
  "arw",
  "dng",
  "orf",
  "raf",
  "pef",
  "x3f",
])

const text = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "mtsx",
  "ctsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "psm1",
  "cmd",
  "bat",
  "json",
  "jsonc",
  "json5",
  "yaml",
  "yml",
  "toml",
  "md",
  "mdx",
  "txt",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "graphql",
  "gql",
  "sql",
  "ini",
  "cfg",
  "conf",
  "env",
])

const textName = new Set([
  "dockerfile",
  "makefile",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".npmrc",
  ".nvmrc",
  ".prettierrc",
  ".eslintrc",
])

const mime: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  svgz: "image/svg+xml",
  avif: "image/avif",
  apng: "image/apng",
  jxl: "image/jxl",
  heic: "image/heic",
  heif: "image/heif",
}

type Entry = { files: string[]; dirs: string[] }

const ext = (file: string) => path.extname(file).toLowerCase().slice(1)
const name = (file: string) => path.basename(file).toLowerCase()
// Binary formats that get a rich preview (base64 returned to the frontend).
// ppt/pptx are intentionally excluded → they keep the empty-binary behavior.
const previewableBinary = new Set(["pdf", "doc", "docx", "xls", "xlsx"])
const isImageByExtension = (file: string) => image.has(ext(file))
const isTextByExtension = (file: string) => text.has(ext(file))
const isTextByName = (file: string) => textName.has(name(file))
const isBinaryByExtension = (file: string) => binary.has(ext(file))
const isImage = (mimeType: string) => mimeType.startsWith("image/")
const getImageMimeType = (file: string) => mime[ext(file)] ?? "image/" + ext(file)

function shouldEncode(mimeType: string) {
  const type = mimeType.toLowerCase()
  log.debug("shouldEncode", { type })
  if (!type) return false
  if (type.startsWith("text/")) return false
  if (type.includes("charset=")) return false
  const top = type.split("/", 2)[0]!
  return ["image", "audio", "video", "font", "model", "multipart"].includes(top)
}

const hidden = (item: string) => {
  const normalized = item.replaceAll("\\", "/").replace(/\/+$/, "")
  return normalized.split("/").some((part) => part.startsWith(".") && part.length > 1)
}

const sortHiddenLast = (items: string[], prefer: boolean) => {
  if (prefer) return items
  const visible: string[] = []
  const hiddenItems: string[] = []
  for (const item of items) {
    if (hidden(item)) hiddenItems.push(item)
    else visible.push(item)
  }
  return [...visible, ...hiddenItems]
}

interface State {
  cache: Entry
  // O(1) lookup sets for incremental cache updates (P7)
  fileSet: Set<string>
  dirSet: Set<string>
}

export interface Interface {
  readonly state: InstanceState.InstanceState<State>
  readonly gitignoreState: InstanceState.InstanceState<{
    ig: ReturnType<typeof ignore> | null
    mtime: number
  }>
  readonly init: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Info[]>
  readonly read: (file: string) => Effect.Effect<Content>
  readonly readDiff: (file: string) => Effect.Effect<DiffContent>
  readonly invalidateDiffCache: (file?: string) => void
  readonly list: (dir?: string) => Effect.Effect<Node[]>
  readonly search: (input: {
    query: string
    limit?: number
    dirs?: boolean
    type?: "file" | "directory"
  }) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/File") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appFs = yield* AppFileSystem.Service
    const rg = yield* Ripgrep.Service
    const git = yield* Git.Service
    const scope = yield* Scope.Scope
    // Resolve the preview-binary flag once at layer setup (Config is available
    // here) and capture it, so `read` keeps its `never` error channel.
    const previewBinaryEnabled = yield* Flag.DUODUO_FILE_PREVIEW_BINARY

    const GITIGNORE_CACHE_TTL_MS = 60_000 // 60s TTL fallback when FileWatcher is unavailable
    const state = yield* InstanceState.make<State>(
      Effect.fn("File.state")(() =>
        Effect.succeed({
          cache: { files: [], dirs: [] } as Entry,
          fileSet: new Set<string>(),
          dirSet: new Set<string>(),
        }),
      ),
    )

    const gitignoreState = yield* InstanceState.make<{
      ig: ReturnType<typeof ignore> | null
      mtime: number
    }>(
      Effect.fn("File.gitignoreCache")(function* (ctx) {
        const ig = ignore()
        if (ctx.project.vcs !== "git") return { ig: null, mtime: Date.now() }
        const [gitignoreText, ignoreText] = yield* Effect.all(
          [
            appFs.readFileString(path.join(ctx.worktree, ".gitignore")).pipe(Effect.catch(() => Effect.succeed(""))),
            appFs.readFileString(path.join(ctx.worktree, ".ignore")).pipe(Effect.catch(() => Effect.succeed(""))),
          ],
          { concurrency: 2 },
        )
        if (gitignoreText) ig.add(gitignoreText)
        if (ignoreText) ig.add(ignoreText)
        return { ig, mtime: Date.now() }
      }),
    )

    const scan = Effect.fn("File.scan")(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.directory === path.parse(ctx.directory).root) return
      const isGlobalHome = ctx.directory === Global.Path.home && ctx.project.id === "global"
      const next: Entry = { files: [], dirs: [] }

      if (isGlobalHome) {
        const dirs = new Set<string>()
        const protectedNames = Protected.names()
        const ignoreNested = new Set(["node_modules", "dist", "build", "target", "vendor"])
        const shouldIgnoreName = (name: string) => name.startsWith(".") || protectedNames.has(name)
        const shouldIgnoreNested = (name: string) => name.startsWith(".") || ignoreNested.has(name)
        const top = yield* appFs.readDirectoryEntries(ctx.directory).pipe(Effect.orElseSucceed(() => []))

        for (const entry of top) {
          if (entry.type !== "directory") continue
          if (shouldIgnoreName(entry.name)) continue
          dirs.add(entry.name + "/")

          const base = path.join(ctx.directory, entry.name)
          const children = yield* appFs.readDirectoryEntries(base).pipe(Effect.orElseSucceed(() => []))
          for (const child of children) {
            if (child.type !== "directory") continue
            if (shouldIgnoreNested(child.name)) continue
            dirs.add(entry.name + "/" + child.name + "/")
          }
        }

        next.dirs = Array.from(dirs).toSorted()
      } else if (ctx.project.vcs === "git") {
        // P6: Use git ls-files for git repos — leverages git's index cache
        // and is 2-3x faster than ripgrep's filesystem traversal.
        const result = yield* git.run(
          [
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.quotepath=false",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
          ],
          { cwd: ctx.directory },
        )
        let files = result.text().split("\0").filter(Boolean)

        // Safety: if git ls-files returns 0 files (git not installed,
        // bare repo, unusual config, or index corruption), fall back
        // to ripgrep filesystem scan.  Also triggered when git.run
        // fails (exitCode != 0), ensuring the scan always produces
        // results on non-empty projects.
        if (files.length === 0) {
          files = [
            ...(yield* rg.files({ cwd: ctx.directory }).pipe(
              Stream.runCollect,
              Effect.map((chunk) => [...chunk]),
            )),
          ]
        }

        const seen = new Set<string>()
        for (const file of files) {
          next.files.push(file)
          let current = file
          while (true) {
            const dir = path.dirname(current)
            if (dir === ".") break
            if (dir === current) break
            current = dir
            if (seen.has(dir)) continue
            seen.add(dir)
            next.dirs.push(dir + "/")
          }
        }
      } else {
        const files = yield* rg.files({ cwd: ctx.directory }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => [...chunk]),
        )
        const seen = new Set<string>()
        for (const file of files) {
          next.files.push(file)
          let current = file
          while (true) {
            const dir = path.dirname(current)
            if (dir === ".") break
            if (dir === current) break
            current = dir
            if (seen.has(dir)) continue
            seen.add(dir)
            next.dirs.push(dir + "/")
          }
        }
      }

      const s = yield* InstanceState.get(state)
      s.cache = next
      // Rebuild O(1) lookup sets from scan results
      s.fileSet = new Set(next.files)
      s.dirSet = new Set(next.dirs)
    })

    let cachedScan = yield* Effect.cached(scan().pipe(Effect.catchCause(() => Effect.void)))

    const ensure = Effect.fn("File.ensure")(function* () {
      yield* cachedScan
      cachedScan = yield* Effect.cached(scan().pipe(Effect.catchCause(() => Effect.void)))
    })

    const gitText = Effect.fnUntraced(function* (args: string[]) {
      return (yield* git.run(args, { cwd: (yield* InstanceState.context).directory })).text()
    })

    const init = Effect.fn("File.init")(function* () {
      yield* ensure().pipe(Effect.forkIn(scope))
    })

    const status = Effect.fn("File.status")(function* () {
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") return []

      // P0: Run all 3 git commands in parallel instead of sequentially.
      const [diffOutput, untrackedOutput, deletedOutput] = yield* Effect.all(
        [
          gitText(["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "diff", "--numstat", "HEAD"]),
          gitText([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.quotepath=false",
            "ls-files",
            "--others",
            "--exclude-standard",
          ]),
          gitText([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.quotepath=false",
            "diff",
            "--name-only",
            "--diff-filter=D",
            "HEAD",
          ]),
        ],
        { concurrency: 3 },
      )

      const changed: Info[] = []

      if (diffOutput.trim()) {
        for (const line of diffOutput.trim().split("\n")) {
          const [added, removed, file] = line.split("\t")
          changed.push({
            path: file ?? "",
            added: (added ?? "-") === "-" ? 0 : parseInt(added!, 10),
            removed: (removed ?? "-") === "-" ? 0 : parseInt(removed!, 10),
            status: "modified",
          })
        }
      }

      // P0: Read untracked file content to count added lines.
      if (untrackedOutput.trim()) {
        for (const file of untrackedOutput.trim().split("\n")) {
          if (!file) continue
          const content = yield* appFs.readFileString(path.join(ctx.directory, file)).pipe(
            Effect.map((s) => s.split("\n").length),
            Effect.catch(() => Effect.succeed(0)),
          )
          changed.push({
            path: file,
            added: content,
            removed: 0,
            status: "added",
          })
        }
      }

      if (deletedOutput.trim()) {
        for (const file of deletedOutput.trim().split("\n")) {
          changed.push({
            path: file,
            added: 0,
            removed: 0,
            status: "deleted",
          })
        }
      }

      return changed.map((item) => {
        const full = path.isAbsolute(item.path) ? item.path : path.join(ctx.directory, item.path)
        return {
          ...item,
          path: path.relative(ctx.directory, full),
        }
      })
    })

    const read: Interface["read"] = Effect.fn("File.read")(function* (file: string) {
      using _ = log.time("read", { file })
      const ctx = yield* InstanceState.context
      const full = path.join(ctx.directory, file)

      if (!Instance.containsPath(full, ctx)) {
        throw new Error("Access denied: path escapes project directory")
      }

      if (isImageByExtension(file)) {
        const exists = yield* appFs.existsSafe(full)
        if (exists) {
          const bytes = yield* appFs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
          return {
            type: "text" as const,
            content: Buffer.from(bytes).toString("base64"),
            mimeType: getImageMimeType(file),
            encoding: "base64" as const,
          }
        }
        return { type: "text" as const, content: "" }
      }

      const knownText = isTextByExtension(file) || isTextByName(file)

      // File preview: return base64 for previewable binary formats so the
      // frontend FilePreview can render them. Flag-guarded (default on, can be
      // rolled back). The frontend keeps these bytes out of the editable-text
      // channel. ppt/pptx are not in `previewableBinary` → they fall through to
      // the empty-binary return below (behavior unchanged).
      if (previewableBinary.has(ext(file)) && !knownText && previewBinaryEnabled) {
        const exists = yield* appFs.existsSafe(full)
        if (exists) {
          const bytes = yield* appFs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
          return {
            type: "binary" as const,
            content: Buffer.from(bytes).toString("base64"),
            mimeType: AppFileSystem.mimeType(full),
            encoding: "base64" as const,
          }
        }
        return { type: "binary" as const, content: "" }
      }

      if (isBinaryByExtension(file) && !knownText) return { type: "binary" as const, content: "" }

      const exists = yield* appFs.existsSafe(full)
      if (!exists) return { type: "text" as const, content: "" }

      const mimeType = AppFileSystem.mimeType(full)
      const encode = knownText ? false : shouldEncode(mimeType)

      if (encode && !isImage(mimeType)) return { type: "binary" as const, content: "", mimeType }

      if (encode) {
        const bytes = yield* appFs.readFile(full).pipe(Effect.catch(() => Effect.succeed(new Uint8Array())))
        return {
          type: "text" as const,
          content: Buffer.from(bytes).toString("base64"),
          mimeType,
          encoding: "base64" as const,
        }
      }

      const content = yield* appFs.readFileString(full).pipe(
        Effect.map((s) => s.trim()),
        Effect.catch(() => Effect.succeed("")),
      )

      // Include diff/patch for tracked text files
// @effect-diagnostics-next-line catchUnfailableEffect:off
      const diffResult = yield* readDiff(file).pipe(Effect.catch(() => Effect.succeed(null)))
      if (diffResult) {
        return { type: "text" as const, content, diff: diffResult.diff, patch: diffResult.patch }
      }

      return { type: "text" as const, content }
    })

    // P5: diff result cache — avoids redundant git spawn on repeated file views.
    // Entries are marked dirty by FileWatcher on file changes.
    const diffCache = new Map<
      string,
      { diff: string; patch: NonNullable<DiffContent>["patch"]; original: string; dirty: boolean }
    >()

    // P5-1: Clean up diffCache on Instance disposal to prevent memory leaks
    // across project switches. registerDisposer callbacks are invoked by
    // disposeInstance when the instance is recycled.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        diffCache.clear()
      }),
    )

    const readDiff: Interface["readDiff"] = Effect.fn("File.readDiff")(function* (file: string) {
      using _ = log.time("readDiff", { file })
      const ctx = yield* InstanceState.context
      if (ctx.project.vcs !== "git") return null

      // Cache hit: skip all git spawn
      const cached = diffCache.get(file)
      if (cached && !cached.dirty) return { diff: cached.diff, patch: cached.patch, original: cached.original }

      let diff = yield* gitText(["-c", "core.fsmonitor=false", "diff", "--", file])
      if (!diff.trim()) {
        diff = yield* gitText(["-c", "core.fsmonitor=false", "diff", "--staged", "--", file])
      }
      if (!diff.trim()) return null

      const content = yield* appFs.readFileString(path.join(ctx.directory, file)).pipe(
        Effect.map((s) => s.trim()),
        Effect.catch(() => Effect.succeed("")),
      )
      const original = yield* git.show(ctx.directory, "HEAD", file)
      const patch = structuredPatch(file, file, original, content, "old", "new", {
        context: Infinity,
        ignoreWhitespace: true,
      })
      const result = { diff: formatPatch(patch), patch, original }
      diffCache.set(file, { ...result, dirty: false })
      return result
    })

    const list = Effect.fn("File.list")(function* (dir?: string) {
      const ctx = yield* InstanceState.context
      const exclude = [".git", ".DS_Store"]
      let ignored = (_: string) => false
      if (ctx.project.vcs === "git") {
        const cached = yield* InstanceState.get(gitignoreState)
        // TTL fallback: invalidate stale cache when FileWatcher is unavailable
        // (normally FileWatcher invalidates immediately on .gitignore change)
        if (Date.now() - cached.mtime > GITIGNORE_CACHE_TTL_MS) {
          yield* InstanceState.invalidate(gitignoreState)
          const fresh = yield* InstanceState.get(gitignoreState)
          if (fresh.ig) ignored = fresh.ig.ignores.bind(fresh.ig)
        } else if (cached.ig) {
          ignored = cached.ig.ignores.bind(cached.ig)
        }
      }

      const resolved = dir ? path.join(ctx.directory, dir) : ctx.directory
      if (!Instance.containsPath(resolved, ctx)) {
        throw new Error("Access denied: path escapes project directory")
      }

      const entries = dir
        ? // Sub-directories tolerate read failures (e.g. removed between listing
          // and reading) and degrade to an empty listing so watchers/UI stay calm.
          yield* appFs.readDirectoryEntries(resolved).pipe(Effect.orElseSucceed((): AppFileSystem.DirEntry[] => []))
        : // The project root must be readable; otherwise die (surfaces as HTTP 500)
          // so the frontend file tree shows a retryable failure instead of a
          // silent blank (e.g. a deleted remote-mirror directory).
          yield* appFs.readDirectoryEntries(resolved).pipe(Effect.orDie)

      const nodes: Node[] = []
      for (const entry of entries) {
        if (exclude.includes(entry.name)) continue
        const absolute = path.join(resolved, entry.name)
        const file = path.relative(ctx.directory, absolute)
        const type = entry.type === "directory" ? "directory" : "file"
        nodes.push({
          name: entry.name,
          path: file,
          absolute,
          type,
          ignored: ignored(type === "directory" ? file + "/" : file),
        })
      }
      return nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1
        return a.name.localeCompare(b.name)
      })
    })

    const search = Effect.fn("File.search")(function* (input: {
      query: string
      limit?: number
      dirs?: boolean
      type?: "file" | "directory"
    }) {
      yield* ensure()
      const { cache } = yield* InstanceState.get(state)

      const query = input.query.trim()
      const limit = input.limit ?? 100
      const kind = input.type ?? (input.dirs === false ? "file" : "all")
      log.info("search", { query, kind })

      const preferHidden = query.startsWith(".") || query.includes("/.")

      if (!query) {
        if (kind === "file") return cache.files.slice(0, limit)
        return sortHiddenLast(cache.dirs.toSorted(), preferHidden).slice(0, limit)
      }

      const items = kind === "file" ? cache.files : kind === "directory" ? cache.dirs : [...cache.files, ...cache.dirs]

      const searchLimit = kind === "directory" && !preferHidden ? limit * 20 : limit
      const sorted = fuzzysort.go(query, items, { limit: searchLimit }).map((item) => item.target)
      const output = kind === "directory" ? sortHiddenLast(sorted, preferHidden).slice(0, limit) : sorted

      log.info("search", { query, kind, results: output.length })
      return output
    })

    // P5: diff cache invalidation helper — marks entries as dirty or clears entirely.
    // Called by FileWatcher on file change events to force re-computation.
    const invalidateDiffCache: Interface["invalidateDiffCache"] = (file?: string) => {
      if (file) {
        const entry = diffCache.get(file)
        if (entry) entry.dirty = true
      } else {
        for (const entry of diffCache.values()) entry.dirty = true
      }
    }

    log.info("init")
    return Service.of({ state, gitignoreState, init, status, read, readDiff, invalidateDiffCache, list, search })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Ripgrep.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Git.defaultLayer),
)

export * as File from "."
