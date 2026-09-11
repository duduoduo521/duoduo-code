#!/usr/bin/env node
/**
 * IntelGear LegacyTsBackend IPC Host
 *
 * Standalone Node.js script that bridges the Rust GearHost to the existing
 * TS plugin system (PluginLoader). Communication is newline-delimited
 * JSON-RPC over stdin/stdout — the same transport pattern as mcp.rs stdio.
 *
 * ## Plugin protocol (see `SDK.md`)
 *
 * A gear plugin is an ES module whose default export is an object with a
 * `server()` method. `server()` returns a server object exposing tools and a
 * call entrypoint. The canonical (MCP-compatible) form is:
 *
 *   export default {
 *     server() {
 *       return {
 *         listTools: async () => ({ tools: [{ name, description?, inputSchema? }] }),
 *         callTool: async ({ name, arguments: args }) => ({ content: [{ type: "text", text }] }),
 *       }
 *     },
 *   }
 *
 * For backward compatibility with existing plugins, the following legacy forms
 * are also accepted and normalized to the canonical shape at load time:
 *   - `server()` returns `{ tools: [...], callTool }` (static tools array)
 *   - `server()` returns `{ _tools: [...], callTool }`
 *   - `server()` returns `{ getRegisteredTools(), callTool }`
 *   - `callTool` may use either `callTool({ name, arguments: args })` (MCP) or
 *     the legacy `callTool(name, arguments)`.
 * Plugins conforming to none of these are rejected with a clear error.
 *
 * ## Lifecycle
 *   → {"jsonrpc":"2.0","id":1,"method":"load","params":{"spec":"./p","kind":"server"}}
 *   ← {"jsonrpc":"2.0","id":1,"result":{"instance":"ts-plugin-1","tools":[...]}}
 *   → {"jsonrpc":"2.0","id":2,"method":"call","params":{"instance","tool","args"}}
 *   ← {"jsonrpc":"2.0","id":2,"result":"tool output text"}
 *   → {"jsonrpc":"2.0","id":3,"method":"unload","params":{"instance":"ts-plugin-1"}}
 *   ← {"jsonrpc":"2.0","id":3,"result":null}
 *
 * npm specs that are not resolvable are auto-installed into an isolated cache
 * dir (env IG_NPM_CACHE_DIR, else a temp dir) with a configurable timeout
 * (env IG_NPM_INSTALL_TIMEOUT_MS, default 120000).
 *
 * Does NOT expose any HTTP API or management routes.
 */

import { createInterface } from "readline"
import { pathToFileURL, fileURLToPath } from "url"
import path from "path"
import fs from "fs"
import os from "os"
import { promisify } from "util"
import { execFile } from "child_process"

// ── State ──

/** @type {Map<string, { spec: string, mod: any, server: any, tools: any[] }>} */
const instances = new Map()
let nextId = 1

// ── Helpers ──

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result })
}

function respondError(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -1, message } })
}

// ── npm auto-install (hardened) ──

const execFileAsync = promisify(execFile)

// Per-process isolated npm cache so auto-install never pollutes the host's
// working directory. Override with IG_NPM_CACHE_DIR. Memoized once spawned.
let _npmCacheDir = null
function npmCacheDir() {
  if (_npmCacheDir) return _npmCacheDir
  const fromEnv = process.env.IG_NPM_CACHE_DIR
  if (fromEnv && fromEnv.trim()) {
    _npmCacheDir = fromEnv.trim()
    fs.mkdirSync(_npmCacheDir, { recursive: true })
  } else {
    _npmCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ig-npm-"))
  }
  return _npmCacheDir
}

async function makeRequire(baseDir) {
  const { createRequire } = await import("module")
  return createRequire(path.join(baseDir, "package.json"))
}

async function tryResolve(spec, baseDir) {
  try {
    const req = await makeRequire(baseDir)
    return req.resolve(spec)
  } catch {
    return null
  }
}

// Install a missing npm package into the isolated cache and resolve it.
async function installAndResolve(spec, cacheDir) {
  const timeoutMs = Number(process.env.IG_NPM_INSTALL_TIMEOUT_MS || 120000)
  try {
    await execFileAsync(
      "npm",
      ["install", "--no-save", "--no-package-lock", "--prefix", cacheDir, spec],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 16 },
    )
  } catch (e) {
    const detail = e.stderr ? String(e.stderr).trim() : e.message
    throw new Error(`npm install of "${spec}" failed: ${detail}`)
  }
  const resolved = await tryResolve(spec, cacheDir)
  if (!resolved) {
    throw new Error(`npm install of "${spec}" succeeded but module is not resolvable from ${cacheDir}`)
  }
  return resolved
}

/**
 * Resolve a plugin spec to a loadable entry path.
 * Supports: file paths (./foo, /abs/path, file://url), npm package names.
 * Unresolvable npm specs are auto-installed into an isolated cache dir.
 */
async function resolveSpec(spec) {
  // file:// URL
  if (spec.startsWith("file://")) {
    return fileURLToPath(spec)
  }
  // Absolute or relative path
  if (spec.startsWith(".") || path.isAbsolute(spec)) {
    return path.resolve(spec)
  }
  // npm package: resolve from host cwd first, then auto-install into cache.
  const resolved = await tryResolve(spec, process.cwd())
  if (resolved) return resolved
  try {
    return await installAndResolve(spec, npmCacheDir())
  } catch (e) {
    throw new Error(`Cannot resolve plugin spec "${spec}": ${e.message}`)
  }
}

/**
 * Import a plugin module and extract its server() entry.
 */
async function loadPluginModule(spec) {
  const entry = await resolveSpec(spec)
  const entryUrl = entry.startsWith("file://") ? entry : pathToFileURL(entry).href

  let mod
  try {
    mod = await import(entryUrl)
  } catch (e) {
    throw new Error(`Failed to import plugin "${spec}" from ${entryUrl}: ${e.message}`)
  }

  if (!mod) {
    throw new Error(`Plugin "${spec}" module is empty`)
  }

  return mod
}

/**
 * Extract and normalize the server object from a plugin's default-exported
 * `server()`. Accepts both the canonical IntelGear protocol (see SDK.md):
 *   server() => { listTools(), callTool() }
 * and legacy forms kept for backward compatibility with existing plugins:
 *   server() => { tools: [...], callTool() }        (static tools array)
 *   server() => { _tools: [...], callTool() }
 *   server() => { getRegisteredTools(), callTool() }
 * Every accepted form is normalized to { listTools, callTool } so the rest of
 * the host only ever handles the canonical shape.
 */
async function extractServer(mod, spec) {
  const def = mod.default ?? mod

  if (typeof def?.server !== "function") {
    throw new Error(
      `Plugin "${spec}" must default-export an object with a server() method ` +
        `(IntelGear plugin protocol — see SDK.md). Got: ${typeof def}`
    )
  }

  const server = await def.server()

  if (!server || typeof server !== "object") {
    throw new Error(`Plugin "${spec}" server() must return an object`)
  }

  // Normalize tool discovery: canonical listTools() wins; otherwise fall back
  // to a legacy static/derived tools source so existing plugins keep working.
  let listTools
  if (typeof server.listTools === "function") {
    listTools = (args) => server.listTools(args)
  } else if (Array.isArray(server.tools)) {
    const tools = server.tools
    listTools = () => ({ tools })
  } else if (Array.isArray(server._tools)) {
    const tools = server._tools
    listTools = () => ({ tools })
  } else if (typeof server.getRegisteredTools === "function") {
    listTools = (args) => server.getRegisteredTools(args)
  }
  if (!listTools) {
    throw new Error(
      `Plugin "${spec}" server() must expose either listTools() or a tools array ` +
        `(IntelGear plugin protocol — see SDK.md)`
    )
  }

  if (typeof server.callTool !== "function") {
    throw new Error(
      `Plugin "${spec}" server() must expose callTool() ` +
        `(IntelGear plugin protocol — see SDK.md)`
    )
  }

  return { def, server: { listTools, callTool: server.callTool } }
}

/**
 * Discover tool definitions from the canonical server object via listTools().
 * Any plugin reaching here has already passed the protocol validation in
 * extractServer, so listTools() is guaranteed to be a function.
 */
async function discoverTools(server, spec) {
  const result = await server.listTools()
  const toolList = result?.tools ?? result ?? []
  if (!Array.isArray(toolList)) {
    throw new Error(`Plugin "${spec}" listTools() did not return a tools array`)
  }
  const tools = []
  for (const t of toolList) {
    if (!t || typeof t.name !== "string") continue
    tools.push({
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
      inputSchema: t.inputSchema ?? t.parameters ?? { type: "object", properties: {} },
    })
  }
  return tools
}

/**
 * Call a tool on the canonical server object via callTool().
 * Normalizes the MCP-style { content: [...] } result to plain text.
 */
async function callTool(server, toolName, args) {
  // Support both the canonical MCP signature callTool({ name, arguments })
  // and the legacy callTool(name, arguments) form.
  const result =
    server.callTool.length >= 2
      ? await server.callTool(toolName, args ?? {})
      : await server.callTool({ name: toolName, arguments: args ?? {} })
  // MCP-style: { content: [{ type: "text", text } | { type: "json", data }] }
  if (result && Array.isArray(result.content)) {
    return result.content
      .map((c) => {
        if (typeof c === "string") return c
        if (typeof c?.text === "string") return c.text
        if (c?.data !== undefined) return JSON.stringify(c.data)
        return ""
      })
      .join("\n")
  }
  if (typeof result === "string") return result
  return JSON.stringify(result ?? null)
}

// ── JSON-RPC Handlers ──

async function handleLoad(id, params) {
  const { spec, kind = "server" } = params ?? {}
  if (!spec) {
    respondError(id, "load: missing 'spec' parameter")
    return
  }

  try {
    const mod = await loadPluginModule(spec)
    const { server } = await extractServer(mod, spec)
    const tools = await discoverTools(server, spec)

    const instanceId = `ts-plugin-${nextId++}`
    instances.set(instanceId, { spec, mod, server, tools })

    respond(id, {
      instance: instanceId,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      })),
    })
  } catch (e) {
    respondError(id, `load failed: ${e.message}`)
  }
}

async function handleCall(id, params) {
  const { instance, tool, args } = params ?? {}
  if (!instance || !tool) {
    respondError(id, "call: missing 'instance' or 'tool' parameter")
    return
  }

  const inst = instances.get(instance)
  if (!inst) {
    respondError(id, `call: unknown instance "${instance}"`)
    return
  }

  try {
    const result = await callTool(inst.server, tool, args ?? {})
    respond(id, result)
  } catch (e) {
    respondError(id, `call failed: ${e.message}`)
  }
}

async function handleUnload(id, params) {
  const { instance } = params ?? {}
  if (!instance) {
    respondError(id, "unload: missing 'instance' parameter")
    return
  }

  const inst = instances.get(instance)
  if (inst) {
    // Call server shutdown if available
    try {
      if (typeof inst.server.close === "function") await inst.server.close()
      if (typeof inst.server.shutdown === "function") await inst.server.shutdown()
    } catch { /* best-effort cleanup */ }
    instances.delete(instance)
  }

  respond(id, null)

  // Exit if no more instances (host will respawn on next load)
  if (instances.size === 0) {
    // Give time for the response to flush
    setTimeout(() => process.exit(0), 100)
  }
}

// ── Main Loop ──

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on("line", async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return // ignore malformed lines
  }

  const { id, method, params } = msg
  if (id === undefined || !method) return

  switch (method) {
    case "load":
      await handleLoad(id, params)
      break
    case "call":
      await handleCall(id, params)
      break
    case "unload":
      await handleUnload(id, params)
      break
    default:
      respondError(id, `unknown method: ${method}`)
  }
})

rl.on("close", () => {
  // stdin closed — parent process exited, clean up
  process.exit(0)
})

// Signal readiness
send({ jsonrpc: "2.0", method: "ready", params: { pid: process.pid } })