// Frontend (webview) error logger for the Tauri desktop app.
//
// Why this exists: on macOS release builds the WKWebView devtools inspector is
// disabled by Apple, so `F12` / `Cmd+Shift+I` cannot open a console. To still be
// able to diagnose frontend errors we persist them to a file:
//   macOS:  ~/Library/Logs/com.duoduo.desktop/frontend_errors.log
//   others: <app_log_dir>/frontend_errors.log
// (same directory as the backend `duoduocode_*.log` files).
//
// We capture three error paths:
//   1. window 'error' / 'unhandledrejection' events   (entry.tsx)
//   2. console.error / console.warn                   (patchConsoleForLogging)
//   3. SolidJS ErrorBoundary render errors             (app.tsx)
// Path #2 is the important one: most app errors are swallowed by try/catch and
// printed via console.error, which never reaches window.onerror.

import { writeTextFile } from "@tauri-apps/plugin-fs"
import { tempDir } from "@tauri-apps/api/path"

type InvokeFn = (cmd: string, args?: unknown) => Promise<unknown>

// Ring-buffer fallback: if the Tauri file write is unavailable (e.g. the webview
// global isn't ready yet, or the sidecar isn't connected), we still keep the last
// N errors in localStorage so they can be retrieved later. Key:
//   "duoduo:frontend-errors" -> JSON array of { ts, level, message }
const LS_KEY = "duoduo:frontend-errors"
const LS_MAX = 50

function persistToLocalStorage(level: string, message: string) {
  try {
    const raw = localStorage.getItem(LS_KEY)
    const arr: Array<{ ts: string; level: string; message: string }> = raw ? JSON.parse(raw) : []
    arr.push({ ts: new Date().toISOString(), level, message })
    while (arr.length > LS_MAX) arr.shift()
    localStorage.setItem(LS_KEY, JSON.stringify(arr))
  } catch {
    // storage may be unavailable (private mode / quota) — non-fatal
  }
}

function getInvoke(): InvokeFn | undefined {
  const w = window as unknown as { __TAURI__?: { core?: { invoke?: InvokeFn } } }
  const invoke = w.__TAURI__?.core?.invoke
  return typeof invoke === "function" ? invoke : undefined
}

// [DEBUG] 把每个 checkpoint 同步落盘到 $TEMP/duoduo-trace.log（整文件重写 + 内存缓冲），
// 即使 webview 卡死也能保留最后写入点。临时目录只解析一次；writeTextFile 的 IPC 同步入队，
// Rust 收到即写。定位冻结后删除。
let traceBuf = ""
let tracePath: string | null = null
let tmpDirPromise: Promise<string> | null = null
function getTmpDir(): Promise<string> {
  if (!tmpDirPromise) tmpDirPromise = tempDir().catch(() => "")
  return tmpDirPromise
}
async function traceToFile(level: string, message: string) {
  try {
    const tmp = await getTmpDir()
    if (!tmp) return
    const sep = tmp.endsWith("\\") || tmp.endsWith("/") ? "" : "\\"
    if (!tracePath) tracePath = `${tmp}${sep}duoduo-trace.log`
    traceBuf += `[${new Date().toISOString()}] ${level} ${message}\n`
    await writeTextFile(tracePath, traceBuf)
  } catch {
    // non-fatal: fs plugin or permission unavailable in this build
  }
}

// Keep a reference to the original console methods so logFrontendError never
// recurses into the patched ones below.
const origError = console.error.bind(console)
const origWarn = console.warn.bind(console)

function formatArg(a: unknown): string {
  if (typeof a === "string") return a
  if (a instanceof Error) return `${a.message}\n${a.stack ?? String(a)}`
  try {
    return JSON.stringify(a)
  } catch {
    return String(a)
  }
}

export function logFrontendError(level: string, message: string) {
  origError(`[frontend:${level}]`, message)
  persistToLocalStorage(level, message)
  void traceToFile(level, message)
  getInvoke()?.("log_frontend_error", { level, message }).catch(() => {})
}

// Return the in-memory (localStorage) ring buffer so it can be copied out without
// opening devtools — e.g. from a debug-build console:
//   copy(JSON.stringify(window.__duoduoFrontendErrors(), null, 2))
// NOTE: the file at ~/Library/Logs/com.duoduo.desktop/frontend_errors.log holds the
// full append-only history; this buffer only keeps the last LS_MAX (50) entries.
export function getFrontendErrors(): Array<{ ts: string; level: string; message: string }> {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

let patched = false

export function patchConsoleForLogging() {
  if (patched || typeof window === "undefined") return
  patched = true
  console.error = (...args: unknown[]) => {
    origError(...args)
    logFrontendError("error", args.map(formatArg).join(" "))
  }
  console.warn = (...args: unknown[]) => {
    origWarn(...args)
    logFrontendError("warn", args.map(formatArg).join(" "))
  }
}

// [TRACE] 启动时把上次崩溃遗留的 trace 落盘到文件，便于取证（与 utils/trace 配合）。
// 程序卡死被杀进程后 localStorage 仍持久化，下次启动时由本函数 dump 到
// $TEMP/duoduo-trace-last.log。定位「打开项目卡死」后删除。
export async function flushCrashTrace(): Promise<void> {
  try {
    const raw = localStorage.getItem("duoduo:trace")
    if (!raw) return
    const tmp = await getTmpDir()
    if (!tmp) return
    const sep = tmp.endsWith("\\") || tmp.endsWith("/") ? "" : "\\"
    await writeTextFile(`${tmp}${sep}duoduo-trace-last.log`, raw)
    localStorage.removeItem("duoduo:trace")
  } catch {
    /* ignore */
  }
}
