import path from "path"
import fs from "fs/promises"
import { createWriteStream, type WriteStream } from "fs"
import { Global } from "../global"
import z from "zod"
import { Glob } from "@duoduo-ai/shared/util/glob"

export const Level = z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).meta({ ref: "LogLevel", description: "Log level" })
export type Level = z.infer<typeof Level>

const levelPriority: Record<Level, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}

// Keep at most this many legacy root-level `<ISO>.log` files (pre-rotation format).
const KEEP_LEGACY = 10
// Size-based rotation threshold per stream.
const MAX_BYTES = 3 * 1024 * 1024
// Number of rotated generations kept (`.1` .. `.MAX_GEN`).
const MAX_GEN = 5
// Default retention window for day directories, in days.
const DEFAULT_RETENTION_DAYS = 7

let level: Level = "INFO"

function shouldLog(input: Level): boolean {
  return levelPriority[input] >= levelPriority[level]
}

export type Logger = {
  debug(message?: any, extra?: Record<string, any>): void
  info(message?: any, extra?: Record<string, any>): void
  error(message?: any, extra?: Record<string, any>): void
  warn(message?: any, extra?: Record<string, any>): void
  tag(key: string, value: string): Logger
  clone(): Logger
  time(
    message: string,
    extra?: Record<string, any>,
  ): {
    stop(): void
    [Symbol.dispose](): void
  }
}

const loggers = new Map<string, Logger>()

export const Default = create({ service: "default" })

export interface Options {
  print: boolean
  dev?: boolean
  level?: Level
  retentionDays?: number
}

// `todayDir` is the active day directory (or "" when logging to stderr/dev).
let todayDir = ""
let logpath = ""
let normalStream: WriteStream | null = null
let errorStream: WriteStream | null = null
let normalBytes = 0
let errorBytes = 0
let rotationEnabled = false

export function file() {
  return logpath
}

// Directory that holds today's log files. Used by the settings "Logs" tab to
// enumerate and clean logs.
export function dir() {
  return todayDir
}

// Local `YYYY-MM-DD`, kept consistent with the Rust side (`chrono::Local`).
function localDay(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function rotate(kind: "normal" | "error") {
  if (!rotationEnabled) return
  const base =
    kind === "normal"
      ? path.join(todayDir, "frontend.log")
      : path.join(todayDir, "frontend.error.log")
  const stream = kind === "normal" ? normalStream : errorStream
  stream?.end()
  // Drop the oldest generation, then shift `.N-1` -> `.N`, then current -> `.1`.
  void fs.unlink(base + "." + MAX_GEN).catch(() => {})
  for (let g = MAX_GEN; g >= 1; g--) {
    const src = g === 1 ? base : base + "." + (g - 1)
    const dst = base + "." + g
    void fs.rename(src, dst).catch(() => {})
  }
  const next = createWriteStream(base, { flags: "a" })
  if (kind === "normal") {
    normalStream = next
    normalBytes = 0
  } else {
    errorStream = next
    errorBytes = 0
  }
}

function writeNormal(msg: string) {
  if (!normalStream) {
    process.stderr.write(msg)
    return
  }
  if (rotationEnabled && normalBytes + msg.length > MAX_BYTES) rotate("normal")
  normalStream.write(msg)
  normalBytes += msg.length
}

function writeError(msg: string) {
  if (!errorStream) {
    process.stderr.write(msg)
    return
  }
  if (rotationEnabled && errorBytes + msg.length > MAX_BYTES) rotate("error")
  errorStream.write(msg)
  errorBytes += msg.length
}

export async function init(options: Options) {
  if (options.level) level = options.level
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS

  // Dev/CLI mode: mirror to stderr, no file output. Still prune legacy files.
  if (options.print) {
    void cleanup(Global.Path.log, retentionDays)
    return
  }

  if (options.dev) {
    // Dev single-file log (no rotation, no error split), kept inside the day
    // directory so it shares the unified tree and is pruned by retention.
    const day = localDay()
    todayDir = path.join(Global.Path.log, day)
    await fs.mkdir(todayDir, { recursive: true })
    logpath = path.join(todayDir, "dev.log")
    await fs.truncate(logpath).catch(() => {})
    normalStream = createWriteStream(logpath, { flags: "a" })
    errorStream = normalStream
    normalBytes = 0
    errorBytes = 0
    rotationEnabled = false
    void cleanup(Global.Path.log, retentionDays)
    return
  }

  // Remove any stale flat `dev.log` left over from a previous dev session
  // (dev logs now live inside the day directory). Safe here because no stream
  // holds the root `dev.log` in production.
  void fs.rm(path.join(Global.Path.log, "dev.log"), { force: true }).catch(() => {})

  const day = localDay()
  todayDir = path.join(Global.Path.log, day)
  await fs.mkdir(todayDir, { recursive: true })
  logpath = path.join(todayDir, "frontend.log")
  const errorPath = path.join(todayDir, "frontend.error.log")
  await fs.truncate(logpath).catch(() => {})
  await fs.truncate(errorPath).catch(() => {})
  normalStream = createWriteStream(logpath, { flags: "a" })
  errorStream = createWriteStream(errorPath, { flags: "a" })
  normalBytes = 0
  errorBytes = 0
  rotationEnabled = true
  void cleanup(Global.Path.log, retentionDays)
}

async function cleanup(root: string, retentionDays: number) {
  // 1) Prune legacy root-level `<ISO>.log` files (pre-rotation format).
  const legacy = (
    await Glob.scan("????-??-??T??????.log", {
      cwd: root,
      absolute: false,
      include: "file",
    }).catch(() => [])
  )
    .filter((file) => path.basename(file) === file)
    .sort()
  if (legacy.length > KEEP_LEGACY) {
    await Promise.all(
      legacy.slice(0, -KEEP_LEGACY).map((file) => fs.unlink(path.join(root, file)).catch(() => {})),
    )
  }

  // 2) Remove day directories older than the retention window.
  if (retentionDays > 0) {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
        .filter((e) => {
          const t = Date.parse(e.name + "T00:00:00Z")
          return !Number.isNaN(t) && t < cutoff
        })
        .map((e) => fs.rm(path.join(root, e.name), { recursive: true, force: true }).catch(() => {})),
    )
  }
}

// Delete every day directory except today's (used by the settings "Logs" tab
// "Clean now" action). Returns the number of directories removed.
export async function cleanAllExceptToday(retentionDays: number = DEFAULT_RETENTION_DAYS): Promise<number> {
  const root = Global.Path.log
  const today = localDay()
  let removed = 0
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .filter((e) => e.name !== today)
      .map(async (e) => {
        await fs.rm(path.join(root, e.name), { recursive: true, force: true }).catch(() => {})
        removed++
      }),
  )
  // Keep day-dir pruning in sync with the retention window as well.
  await cleanup(root, retentionDays)
  return removed
}

function formatError(error: Error, depth = 0): string {
  const result = error.message
  return error.cause instanceof Error && depth < 10
    ? result + " Caused by: " + formatError(error.cause, depth + 1)
    : result
}

let last = Date.now()
export function create(tags?: Record<string, any>) {
  tags = tags || {}

  const service = tags["service"]
  if (service && typeof service === "string") {
    const cached = loggers.get(service)
    if (cached) {
      return cached
    }
  }

  function build(message: any, extra?: Record<string, any>) {
    const prefix = Object.entries({
      ...tags,
      ...extra,
    })
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        const prefix = `${key}=`
        if (value instanceof Error) return prefix + formatError(value)
        if (typeof value === "object") return prefix + JSON.stringify(value)
        return prefix + value
      })
      .join(" ")
    const next = new Date()
    const diff = next.getTime() - last
    last = next.getTime()
    return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
  }
  const result: Logger = {
    debug(message?: any, extra?: Record<string, any>) {
      if (shouldLog("DEBUG")) {
        writeNormal("DEBUG " + build(message, extra))
      }
    },
    info(message?: any, extra?: Record<string, any>) {
      if (shouldLog("INFO")) {
        writeNormal("INFO  " + build(message, extra))
      }
    },
    error(message?: any, extra?: Record<string, any>) {
      if (shouldLog("ERROR")) {
        // Errors go to both the error stream and the normal stream.
        writeError("ERROR " + build(message, extra))
        writeNormal("ERROR " + build(message, extra))
      }
    },
    warn(message?: any, extra?: Record<string, any>) {
      if (shouldLog("WARN")) {
        writeNormal("WARN  " + build(message, extra))
      }
    },
    tag(key: string, value: string) {
      if (tags) tags[key] = value
      return result
    },
    clone() {
      return create({ ...tags })
    },
    time(message: string, extra?: Record<string, any>) {
      const now = Date.now()
      result.info(message, { status: "started", ...extra })
      function stop() {
        result.info(message, {
          status: "completed",
          duration: Date.now() - now,
          ...extra,
        })
      }
      return {
        stop,
        [Symbol.dispose]() {
          stop()
        },
      }
    },
  }

  if (service && typeof service === "string") {
    loggers.set(service, result)
  }

  return result
}
