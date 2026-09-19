import { DuoduoError } from "@/util/error"
import { dynamicTool, type Tool, jsonSchema, type JSONSchema7 } from "ai"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  CallToolResultSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "../config"
import { ConfigMCP } from "../config/mcp"
import { Log } from "../util"
import { NamedError } from "@duoduo-ai/shared/util/error"
import z from "zod/v4"
import { Installation } from "../installation"
import { InstallationVersion } from "../installation/version"
import { withTimeout } from "@/util/timeout"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { McpOAuthProvider } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "@/bus"
import * as fs from "node:fs"
import path from "node:path"
import { Global } from "@/global"
import { TuiEvent } from "@/cli/cmd/tui/event"
import open from "open"
import { Effect, Exit, Layer, Option, Context, Stream, Cause } from "effect"
import { EffectBridge } from "@/effect"
import { InstanceState } from "@/effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"

const log = Log.create({ service: "mcp" })
const DEFAULT_TIMEOUT = 30_000
const MANUAL_AUTH_TIMEOUT_MS = 60_000

export const Resource = z
  .object({
    name: z.string(),
    uri: z.string(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    client: z.string(),
  })
  .meta({ ref: "McpResource" })
export type Resource = z.infer<typeof Resource>

export const ToolsChanged = BusEvent.define(
  "mcp.tools.changed",
  z.object({
    server: z.string(),
  }),
)

export const BrowserOpenFailed = BusEvent.define(
  "mcp.browser.open.failed",
  z.object({
    mcpName: z.string(),
    url: z.string(),
  }),
)

export const Failed = NamedError.create(
  "MCPFailed",
  z.object({
    name: z.string(),
  }),
)

type MCPClient = Client

export const Status = z
  .discriminatedUnion("status", [
    z
      .object({
        status: z.literal("connected"),
      })
      .meta({
        ref: "MCPStatusConnected",
      }),
    z
      .object({
        status: z.literal("disabled"),
      })
      .meta({
        ref: "MCPStatusDisabled",
      }),
    z
      .object({
        status: z.literal("failed"),
        error: z.string(),
      })
      .meta({
        ref: "MCPStatusFailed",
      }),
    z
      .object({
        status: z.literal("needs_auth"),
      })
      .meta({
        ref: "MCPStatusNeedsAuth",
      }),
    z
      .object({
        status: z.literal("needs_client_registration"),
        error: z.string(),
      })
      .meta({
        ref: "MCPStatusNeedsClientRegistration",
      }),
  ])
  .meta({
    ref: "MCPStatus",
  })
export type Status = z.infer<typeof Status>

// Store transports for OAuth servers to allow finishing auth
type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
const pendingOAuthTransports = new Map<string, TransportWithAuth>()

// Prompt cache types
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
type McpEntry = NonNullable<Config.Info["mcp"]>[string]

function isMcpConfigured(entry: McpEntry): entry is ConfigMCP.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

// ── 智械 (IntelGear) MCP integration ────────────────────────────────────
// Gears created via `POST /gears/mcp` (duo-smart-layer) persist an external
// MCP server as `<cache>/gears/<name>/tools/mcp.json` with the shape
// `{ kind: "stdio"|"sse", command, args, url }`. We translate that into the
// native `ConfigMCP.Info` union so the gear's tools are surfaced to the agent
// exactly like any other MCP server — fulfilling the "智械 covers MCP" goal.
function gearMcpToConfigMcp(raw: unknown): ConfigMCP.Info | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  // B8: kind defaults to "stdio" — matching the Rust loader (mcp.rs), so a
  // gear mcp.json without an explicit kind loads identically on both sides.
  const kind = typeof r.kind === "string" ? r.kind : "stdio"
  if (kind === "stdio") {
    const commandStr = typeof r.command === "string" ? r.command.trim() : ""
    if (!commandStr) return undefined
    // P0-6: gear mcp.json is remote-authored input (registry/CLI install).
    // The stdio transport spawns the command directly, but a command carrying
    // shell metacharacters must never be loadable from a gear pack without
    // review — reject it and keep the gear's other tools unaffected.
    if (/[;|&`$><\r\n]/.test(commandStr)) {
      log.warn("gear mcp.json command rejected: shell metacharacters", {
        command: commandStr,
      })
      return undefined
    }
    const args = Array.isArray(r.args)
      ? (r.args.filter((a) => typeof a === "string") as string[])
      : []
    // B8: pass `env` through (the Rust loader always did) — gears that
    // authenticate via environment variables silently failed on TS before.
    const environment =
      r.env && typeof r.env === "object" && !Array.isArray(r.env)
        ? Object.fromEntries(
            Object.entries(r.env as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : undefined
    return {
      type: "local",
      command: [commandStr, ...args],
      ...(environment ? { environment } : {}),
    }
  }
  if (kind === "sse") {
    const url = typeof r.url === "string" ? r.url.trim() : ""
    if (!url) return undefined
    return { type: "remote", url }
  }
  return undefined
}

/** B5: interrupted installs leave `<name>.tmp-*` / `<name>.broken-*` staging
 *  dirs inside the gears store — they are not gears and must never load. */
function isGearStagingDir(name: string): boolean {
  return name.includes(".tmp-") || name.includes(".broken-")
}

/** B7: read the manifest's `[meta] name` (the override key the Rust loader
 *  uses), falling back to the directory name. */
function readManifestMetaName(manifestPath: string): string | undefined {
  try {
    const text = fs.readFileSync(manifestPath, "utf8")
    const meta = text.match(/\[meta\]([\s\S]*?)(\n\[|$)/)
    return meta?.[1]?.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1]
  } catch {
    return undefined
  }
}

/** B7: honour `.activation_overrides.json` (the Settings on/off switch, the
 *  same file the Rust loader reads) — a disabled gear's MCP servers must not
 *  load on the TS side either. */
function gearDisabledByOverride(gearsDir: string, dirName: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(gearsDir, ".activation_overrides.json"), "utf8")) as Record<
      string,
      unknown
    >
    const metaName = readManifestMetaName(path.join(gearsDir, dirName, "manifest.toml"))
    const value = raw[metaName ?? dirName] ?? raw[dirName]
    // Legacy repr: a plain activation-mode string (enabled). Full repr: an
    // object carrying `enabled`.
    if (value && typeof value === "object" && "enabled" in value) {
      return (value as { enabled?: boolean }).enabled === false
    }
    return false
  } catch {
    return false
  }
}

/** Load MCP server declarations from installed 智械 gears. */
function loadGearMcpServers(): Record<string, ConfigMCP.Info> {
  const out: Record<string, ConfigMCP.Info> = {}
  try {
    const gearsDir = process.env.DUODUO_GEARS_DIR ? path.resolve(process.env.DUODUO_GEARS_DIR) : Global.Path.gears
    const entries = fs.readdirSync(gearsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (isGearStagingDir(entry.name)) continue
      if (gearDisabledByOverride(gearsDir, entry.name)) continue
      const mcpJson = path.join(gearsDir, entry.name, "tools", "mcp.json")
      let raw: unknown
      try {
        raw = JSON.parse(fs.readFileSync(mcpJson, "utf8"))
      } catch {
        continue
      }
      const info = gearMcpToConfigMcp(raw)
      if (info) out[`gear:${entry.name}`] = info
    }
  } catch {
    // No gears dir yet (fresh install) — degrade to no gear MCP servers.
  }
  return out
}

/** `cfg.mcp` plus any MCP servers declared by installed 智械 gears. */
function mergedMcpConfig(cfg: Config.Info): Record<string, ConfigMCP.Info> {
  return { ...(cfg.mcp ?? {}), ...loadGearMcpServers() } as Record<string, ConfigMCP.Info>
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")

/** Simple hash for collision-resistant naming */
function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  }
  return h
}

/** Generate a unique tool name, using hash prefix on collision */
function makeToolName(clientName: string, toolName: string, existingNames: Set<string>): string {
  const base = `${sanitize(clientName)}_${sanitize(toolName)}`
  if (!existingNames.has(base)) return base

  // Collision detected: use hash prefix
  const hash = hashCode(`${clientName}:${toolName}`).toString(36).slice(0, 6)
  return `${sanitize(clientName)}_${hash}_${sanitize(toolName)}`
}

// Convert MCP tool definition to AI SDK Tool type
function convertMcpTool(mcpTool: MCPToolDef, client: MCPClient, timeout?: number): Tool {
  const inputSchema = mcpTool.inputSchema

  // Spread first, then override type to ensure it's always "object"
  const schema: JSONSchema7 = {
    ...(inputSchema as JSONSchema7),
    type: "object",
    properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(schema),
    execute: async (args: unknown) => {
      return client.callTool(
        {
          name: mcpTool.name,
          arguments: (args || {}) as Record<string, unknown>,
        },
        CallToolResultSchema,
        {
          resetTimeoutOnProgress: true,
          timeout,
        },
      )
    },
  })
}

function defs(key: string, client: MCPClient, timeout?: number) {
// @effect-diagnostics-next-line globalErrorInEffectCatch:off
  return Effect.tryPromise({
    try: () => withTimeout(client.listTools(), timeout ?? DEFAULT_TIMEOUT),
    catch: (err) => (err instanceof Error ? err : new DuoduoError({ message: String(err), cause: err })),
  }).pipe(
    Effect.map((result) => result.tools),
    Effect.catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
      return Effect.void
    }),
  )
}

function fetchFromClient<T extends { name: string }>(
  clientName: string,
  client: Client,
  listFn: (c: Client) => Promise<T[]>,
  label: string,
) {
  return Effect.tryPromise({
    try: () => listFn(client),
    catch: (e: any) => {
      log.error(`failed to get ${label}`, { clientName, error: e.message })
      return new Cause.UnknownError(e)
    },
  }).pipe(
    Effect.map((items) => {
      const out: Record<string, T & { client: string }> = {}
      const sanitizedClient = sanitize(clientName)
      for (const item of items) {
        out[sanitizedClient + ":" + sanitize(item.name)] = { ...item, client: clientName }
      }
      return out
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

interface CreateResult {
  mcpClient?: MCPClient
  status: Status
  defs?: MCPToolDef[]
}

interface AuthResult {
  authorizationUrl: string
  oauthState: string
  client?: MCPClient
}

// --- Effect Service ---

interface State {
  status: Record<string, Status>
  clients: Record<string, MCPClient>
  defs: Record<string, MCPToolDef[]>
}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  readonly tools: () => Effect.Effect<Record<string, Tool>>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: () => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly add: (name: string, mcp: ConfigMCP.Info) => Effect.Effect<{ status: Record<string, Status> | Status }, Error>
  readonly connect: (name: string) => Effect.Effect<void, Error>
  readonly disconnect: (name: string) => Effect.Effect<void, Error>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined>
  readonly startAuth: (mcpName: string) => Effect.Effect<{ authorizationUrl: string; oauthState: string }, Error>
  readonly authenticate: (mcpName: string) => Effect.Effect<Status, Error>
  readonly finishAuth: (mcpName: string, authorizationCode: string) => Effect.Effect<Status, Error>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/MCP") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const auth = yield* McpAuth.Service
    const bus = yield* Bus.Service

    type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

    /**
     * Connect a client via the given transport with resource safety:
     * on failure the transport is closed; on success the caller owns it.
     */
    const connectTransport = (transport: Transport, timeout: number) =>
      Effect.acquireUseRelease(
        Effect.succeed(transport),
        (t) =>
// @effect-diagnostics-next-line globalErrorInEffectCatch:off
          Effect.tryPromise({
            try: () => {
              const client = new Client({ name: "duoduocode", version: InstallationVersion })
              return withTimeout(client.connect(t), timeout).then(() => client)
            },
            catch: (e) => (e instanceof Error ? e : new DuoduoError({ message: String(e), cause: e })),
          }),
        (t, exit) => (Exit.isFailure(exit) ? Effect.tryPromise(() => t.close()).pipe(Effect.ignore) : Effect.void),
      )

    const DISABLED_RESULT: CreateResult = { status: { status: "disabled" } }

    const connectRemote = Effect.fn("MCP.connectRemote")(function* (
      key: string,
      mcp: ConfigMCP.Info & { type: "remote" },
    ) {
      // Proactively check if OAuth token is expired before connecting
      if (mcp.oauth !== false) {
// @effect-diagnostics-next-line catchUnfailableEffect:off
        const isExpired = yield* auth.isTokenExpired(key).pipe(Effect.catch(() => Effect.succeed(null)))
        if (isExpired === true) {
          log.info("mcp oauth token expired, will refresh on reconnect", { key })
        }
      }

      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
            redirectUri: oauthConfig?.redirectUri,
          },
          {
            onRedirect: async (url) => {
              log.info("oauth redirect requested", { key, url: url.toString() })
            },
          },
          auth,
        )
      }

      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(new URL(mcp.url), {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(new URL(mcp.url), {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
      ]

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      let lastStatus: Status | undefined

      for (const { name, transport } of transports) {
        const result = yield* connectTransport(transport, connectTimeout).pipe(
          Effect.map((client) => ({ client, transportName: name })),
          Effect.catch((error) => {
            const lastError = error instanceof Error ? error : new DuoduoError({ message: String(error), cause: error })
            const isAuthError =
              error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

            if (isAuthError) {
              log.info("mcp server requires authentication", { key, transport: name })

              if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
                lastStatus = {
                  status: "needs_client_registration" as const,
                  error: "Server does not support dynamic client registration. Please provide clientId in config.",
                }
                return bus
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              } else {
                pendingOAuthTransports.set(key, transport)
                lastStatus = { status: "needs_auth" as const }
                return bus
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires authentication. Run: duoduo mcp auth ${key}`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              }
            }

            log.debug("transport connection failed", {
              key,
              transport: name,
              url: mcp.url,
              error: lastError.message,
            })
            lastStatus = { status: "failed" as const, error: lastError.message }
            return Effect.void
          }),
        )
        if (result) {
          log.info("connected", { key, transport: result.transportName })
          return { client: result.client as MCPClient | undefined, status: { status: "connected" } as Status }
        }
        // If this was an auth error, stop trying other transports
        if (lastStatus?.status === "needs_auth" || lastStatus?.status === "needs_client_registration") break
      }

      return {
        client: undefined as MCPClient | undefined,
        status: (lastStatus ?? { status: "failed", error: "Unknown error" }),
      }
    })

    const connectLocal = Effect.fn("MCP.connectLocal")(function* (
      key: string,
      mcp: ConfigMCP.Info & { type: "local" },
    ) {
      const [cmd, ...args] = mcp.command
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
      if (!cmd) return yield* Effect.fail(new DuoduoError({ message: String(`MCP command is empty for ${key}`), messageZh: String(`MCP 命令为空（${key}）`), cause: undefined }))
      const cwd = yield* InstanceState.directory
      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args,
        cwd,
        env: {
          ...process.env,
          ...(cmd === "duoduo" ? { BUN_BE_BUN: "1" } : {}),
          ...mcp.environment,
        },
      })
      transport.stderr?.on("data", (chunk: Buffer) => {
        log.info(`mcp stderr: ${chunk.toString()}`, { key })
      })

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      return yield* connectTransport(transport, connectTimeout).pipe(
        Effect.map((client): { client: MCPClient | undefined; status: Status } => ({
          client,
          status: { status: "connected" },
        })),
        Effect.catch((error): Effect.Effect<{ client: MCPClient | undefined; status: Status }> => {
          const msg = error instanceof Error ? error.message : String(error)
          log.error("local mcp startup failed", { key, command: mcp.command, cwd, error: msg })
          return Effect.succeed({ client: undefined, status: { status: "failed", error: msg } })
        }),
      )
    })

    const create = Effect.fn("MCP.create")(function* (key: string, mcp: ConfigMCP.Info) {
      if (mcp.enabled === false) {
        log.info("mcp server disabled", { key })
        return DISABLED_RESULT
      }

      log.info("found", { key, type: mcp.type })

      const { client: mcpClient, status } =
        mcp.type === "remote"
          ? yield* connectRemote(key, mcp as ConfigMCP.Info & { type: "remote" })
          : yield* connectLocal(key, mcp as ConfigMCP.Info & { type: "local" })

      if (!mcpClient) {
        return { status } satisfies CreateResult
      }

      const listed = yield* defs(key, mcpClient, mcp.timeout)
      if (!listed) {
        yield* Effect.tryPromise(() => mcpClient.close()).pipe(Effect.ignore)
        return { status: { status: "failed", error: "Failed to get tools" } } satisfies CreateResult
      }

      log.info("create() successfully created client", { key, toolCount: listed.length })
      return { mcpClient, status, defs: listed } satisfies CreateResult
    })
    const cfgSvc = yield* Config.Service

    const descendants = Effect.fnUntraced(
      function* (pid: number) {
        if (process.platform === "win32") return [] as number[]
        const pids: number[] = []
        const queue = [pid]
        while (queue.length > 0) {
          const current = queue.shift()!
          const handle = yield* spawner.spawn(ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" }))
          const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          for (const tok of text.split("\n")) {
            const cpid = parseInt(tok, 10)
            if (!isNaN(cpid) && !pids.includes(cpid)) {
              pids.push(cpid)
              queue.push(cpid)
            }
          }
        }
        return pids
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed([] as number[])),
    )

    function watch(s: State, name: string, client: MCPClient, bridge: EffectBridge.Shape, timeout?: number) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        log.info("tools list changed notification received", { server: name })
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        const listed = await bridge.promise(defs(name, client, timeout))
        if (!listed) return
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        s.defs[name] = listed
        await bridge.promise(bus.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      })

      // Auto-reconnect with exponential backoff when connection closes
      const MAX_RECONNECT_ATTEMPTS = 5
      const BASE_DELAY_MS = 1000
      let reconnectAttempts = 0

      const attemptReconnect = async () => {
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          log.warn("mcp reconnect max attempts reached", { name })
          return
        }
        const delay = BASE_DELAY_MS * Math.pow(2, reconnectAttempts)
        reconnectAttempts++
        log.info("mcp reconnecting", { name, attempt: reconnectAttempts, delayMs: delay })
        await new Promise((r) => setTimeout(r, delay))
        try {
          await bridge.promise(
            Effect.gen(function* () {
              yield* connect(name)
              reconnectAttempts = 0
              log.info("mcp reconnected", { name })
            }),
          )
        } catch (err) {
          log.warn("mcp reconnect failed", { name, attempt: reconnectAttempts, err })
          // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
          attemptReconnect()
        }
      }

      client.onclose = () => {
        log.warn("mcp connection closed", { name })
        if (s.clients[name] === client) {
          s.status[name] = { status: "failed", error: "Connection closed unexpectedly" }
          // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
          attemptReconnect()
        }
      }
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* () {
        const cfg = yield* cfgSvc.get()
        const bridge = yield* EffectBridge.make()
        const config = mergedMcpConfig(cfg)
        const s: State = {
          status: {},
          clients: {},
          defs: {},
        }

        yield* Effect.forEach(
          Object.entries(config),
          ([key, mcp]) =>
            Effect.gen(function* () {
              if (!isMcpConfigured(mcp)) {
                log.error("Ignoring MCP config entry without type", { key })
                return
              }

              if (mcp.enabled === false) {
                s.status[key] = { status: "disabled" }
                return
              }

              const result = yield* create(key, mcp).pipe(Effect.catch(() => Effect.void))
              if (!result) return

              s.status[key] = result.status
              if (result.mcpClient) {
                s.clients[key] = result.mcpClient
                s.defs[key] = result.defs!
                watch(s, key, result.mcpClient, bridge, mcp.timeout)
              }
            }),
          { concurrency: "unbounded" },
        )

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Effect.forEach(
              Object.values(s.clients),
              (client) =>
                Effect.gen(function* () {
                  const pid = client.transport instanceof StdioClientTransport ? client.transport.pid : null
                  if (typeof pid === "number") {
                    const pids = yield* descendants(pid)
                    for (const dpid of pids) {
// @effect-diagnostics-next-line tryCatchInEffectGen:off
                      try {
                        process.kill(dpid, "SIGTERM")
                      } catch {}
                    }
                  }
                  yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
                }),
              { concurrency: "unbounded" },
            )
            pendingOAuthTransports.clear()
          }),
        )

        return s
      }),
    )

    function closeClient(s: State, name: string) {
      const client = s.clients[name]
      delete s.defs[name]
      if (!client) return Effect.void
      return Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
    }

    const storeClient = Effect.fnUntraced(function* (
      s: State,
      name: string,
      client: MCPClient,
      listed: MCPToolDef[],
      timeout?: number,
    ) {
      const bridge = yield* EffectBridge.make()
      yield* closeClient(s, name)
      s.status[name] = { status: "connected" }
      s.clients[name] = client
      s.defs[name] = listed
      watch(s, name, client, bridge, timeout)
      return s.status[name]
    })

    const status = Effect.fn("MCP.status")(function* () {
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = mergedMcpConfig(cfg)
      const result: Record<string, Status> = {}

      for (const [key, mcp] of Object.entries(config)) {
        if (!isMcpConfigured(mcp)) continue
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      return result
    })

    const clients = Effect.fn("MCP.clients")(function* () {
      const s = yield* InstanceState.get(state)
      return s.clients
    })

    const createAndStore = Effect.fn("MCP.createAndStore")(function* (name: string, mcp: ConfigMCP.Info) {
      const s = yield* InstanceState.get(state)
      const result = yield* create(name, mcp)

      s.status[name] = result.status
      if (!result.mcpClient) {
        yield* closeClient(s, name)
        delete s.clients[name]
        return result.status
      }

      return yield* storeClient(s, name, result.mcpClient, result.defs!, mcp.timeout)
    })

    const add = Effect.fn("MCP.add")(function* (name: string, mcp: ConfigMCP.Info) {
      yield* createAndStore(name, mcp)
      const s = yield* InstanceState.get(state)
      return { status: s.status }
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const mcp = yield* getMcpConfig(name)
      if (!mcp) {
        log.error("MCP config not found or invalid", { name })
        return
      }
      yield* createAndStore(name, { ...mcp, enabled: true })
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      yield* closeClient(s, name)
      delete s.clients[name]
      s.status[name] = { status: "disabled" }
    })

    const tools = Effect.fn("MCP.tools")(function* () {
      const result: Record<string, Tool> = {}
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = mergedMcpConfig(cfg)
      const defaultTimeout = cfg.experimental?.mcp_timeout

      const connectedClients = Object.entries(s.clients).filter(
        ([clientName]) =>
          s.status[clientName]?.status === "connected" &&
          // B6: a gear uninstalled (or a server removed from config) must stop
          // exposing its tools even while its connection lingers until the
          // next reconnect cycle prunes it.
          config[clientName] !== undefined,
      )

      yield* Effect.forEach(
        connectedClients,
        ([clientName, client]) =>
          Effect.gen(function* () {
            const mcpConfig = config[clientName]
            const entry = mcpConfig && isMcpConfigured(mcpConfig) ? mcpConfig : undefined

            const listed = s.defs[clientName]
            if (!listed) {
              log.warn("missing cached tools for connected server", { clientName })
              return
            }

            const timeout = entry?.timeout ?? defaultTimeout
            const existingNames = new Set(Object.keys(result))
            for (const mcpTool of listed) {
              const toolName = makeToolName(clientName, mcpTool.name, existingNames)
              existingNames.add(toolName)
              result[toolName] = convertMcpTool(mcpTool, client, timeout)
            }
          }),
        { concurrency: "unbounded" },
      )
      return result
    })

    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client) => Promise<T[]>,
      label: string,
    ) {
      return Effect.forEach(
        Object.entries(s.clients).filter(([name]) => s.status[name]?.status === "connected"),
        ([clientName, client]) =>
          fetchFromClient(clientName, client, listFn, label).pipe(Effect.map((items) => Object.entries(items ?? {}))),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((results) => Object.fromEntries<T & { client: string }>(results.flat())))
    }

    const prompts = Effect.fn("MCP.prompts")(function* () {
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(s, (c) => c.listPrompts().then((r) => r.prompts), "prompts")
    })

    const resources = Effect.fn("MCP.resources")(function* () {
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(s, (c) => c.listResources().then((r) => r.resources), "resources")
    })

    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: MCPClient) => Promise<A>,
      label: string,
      meta?: Record<string, unknown>,
    ) {
      const s = yield* InstanceState.get(state)
      const client = s.clients[clientName]
      if (!client) {
        log.warn(`client not found for ${label}`, { clientName })
        return undefined
      }
      return yield* Effect.tryPromise({
        try: () => fn(client),
        catch: (e: any) => {
          log.error(`failed to ${label}`, { clientName, ...meta, error: e?.message })
          return new Cause.UnknownError(e)
        },
      }).pipe(Effect.orElseSucceed(() => undefined))
    })

    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      return yield* withClient(clientName, (client) => client.getPrompt({ name, arguments: args }), "getPrompt", {
        promptName: name,
      })
    })

    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      return yield* withClient(clientName, (client) => client.readResource({ uri: resourceUri }), "readResource", {
        resourceUri,
      })
    })

    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const cfg = yield* cfgSvc.get()
      const mcpConfig = mergedMcpConfig(cfg)[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig)) return undefined
      return mcpConfig
    })

    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) throw new DuoduoError({ message: String(`MCP server ${mcpName} not found or disabled`), messageZh: String(`找不到或已禁用 MCP 服务 ${mcpName}`), cause: undefined })
      if (mcpConfig.type !== "remote") throw new DuoduoError({ message: String(`MCP server ${mcpName} is not a remote server`), messageZh: String(`MCP 服务 ${mcpName} 不是远程服务`), cause: undefined })
      if (mcpConfig.oauth === false) throw new DuoduoError({ message: String(`MCP server ${mcpName} has OAuth explicitly disabled`), messageZh: String(`MCP 服务 ${mcpName} 已显式禁用 OAuth`), cause: undefined })

      // OAuth config is optional - if not provided, we'll use auto-discovery
      const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined

      // Start the callback server with custom redirectUri if configured
      yield* Effect.promise(() => McpOAuthCallback.ensureRunning(oauthConfig?.redirectUri))

      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      yield* auth.updateOAuthState(mcpName, oauthState)
      let capturedUrl: URL | undefined
      const authProvider = new McpOAuthProvider(
        mcpName,
        mcpConfig.url,
        {
          clientId: oauthConfig?.clientId,
          clientSecret: oauthConfig?.clientSecret,
          scope: oauthConfig?.scope,
          redirectUri: oauthConfig?.redirectUri,
        },
        {
          onRedirect: async (url) => {
            capturedUrl = url
          },
        },
        auth,
      )

      const transport = new StreamableHTTPClientTransport(new URL(mcpConfig.url), { authProvider })

      return yield* Effect.tryPromise({
        try: () => {
          const client = new Client({ name: "duoduocode", version: InstallationVersion })
          return client
            .connect(transport)
            .then(() => ({ authorizationUrl: "", oauthState, client }) satisfies AuthResult)
        },
        catch: (error) => error as Cause.UnknownError,
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof UnauthorizedError && capturedUrl) {
            pendingOAuthTransports.set(mcpName, transport)
            return Effect.succeed({ authorizationUrl: capturedUrl.toString(), oauthState } satisfies AuthResult)
          }
          return Effect.die(error)
        }),
      )
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (mcpName: string) {
      const result = yield* startAuth(mcpName)
      if (!result.authorizationUrl) {
        const client = "client" in result ? result.client : undefined
        const mcpConfig = yield* getMcpConfig(mcpName)
        if (!mcpConfig) {
          yield* Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)
          return { status: "failed", error: "MCP config not found after auth" } as Status
        }

        const listed = client ? yield* defs(mcpName, client, mcpConfig.timeout) : undefined
        if (!client || !listed) {
          yield* Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)
          return { status: "failed", error: "Failed to get tools" } as Status
        }

        const s = yield* InstanceState.get(state)
        yield* auth.clearOAuthState(mcpName)
        return yield* storeClient(s, mcpName, client, listed, mcpConfig.timeout)
      }

      log.info("opening browser for oauth", { mcpName, url: result.authorizationUrl, state: result.oauthState })

      const callbackPromise = McpOAuthCallback.waitForCallback(result.oauthState, mcpName)

      const openResult = yield* Effect.tryPromise(() => open(result.authorizationUrl)).pipe(
        Effect.flatMap((subprocess) =>
          Effect.callback<void, Error>((resume) => {
            const timer = setTimeout(() => resume(Effect.void), 500)
            subprocess.on("error", (err) => {
              clearTimeout(timer)
              resume(Effect.fail(err))
            })
            subprocess.on("exit", (code) => {
              if (code !== null && code !== 0) {
                clearTimeout(timer)
                resume(Effect.fail(new DuoduoError({ message: String(`Browser open failed with exit code ${code}`), messageZh: String(`浏览器打开失败，退出码 ${code}`), cause: undefined })))
              }
            })
          }),
        ),
        Effect.exit,
      )

      if (Exit.isFailure(openResult)) {
        log.warn("failed to open browser, user must open URL manually", { mcpName })
        yield* bus.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)

        // Give the user a window to complete OAuth manually (e.g. CLI printed the URL)
        // before giving up and returning needs_auth.
// @effect-diagnostics-next-line globalErrorInEffectCatch:off
        const manualCode = yield* Effect.tryPromise({
          try: () => {
            let timeoutId: ReturnType<typeof setTimeout>
            return Promise.race([
              callbackPromise,
              new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new DuoduoError({ message: "Manual auth timeout", messageZh: "手动授权超时", cause: undefined })), MANUAL_AUTH_TIMEOUT_MS)
              }),
            ]).finally(() => clearTimeout(timeoutId))
          },
          catch: (error) => (error instanceof Error ? error : new DuoduoError({ message: String(error), cause: error })),
        }).pipe(
          Effect.catch(() => {
            McpOAuthCallback.cancelPending(mcpName)
            pendingOAuthTransports.delete(mcpName)
            return Effect.succeed(null)
          }),
        )

        if (manualCode === null) {
          return { status: "needs_auth" } as Status
        }

        const storedState = yield* auth.getOAuthState(mcpName)
        if (storedState !== result.oauthState) {
          yield* auth.clearOAuthState(mcpName)
          throw new DuoduoError({ message: "OAuth state mismatch - potential CSRF attack", messageZh: "OAuth state 不匹配——潜在的 CSRF 攻击", cause: undefined })
        }
        yield* auth.clearOAuthState(mcpName)
        return yield* finishAuth(mcpName, manualCode)
      }

      // Browser opened successfully — wait for OAuth callback
      const code = yield* Effect.promise(() => callbackPromise)

      const storedState = yield* auth.getOAuthState(mcpName)
      if (storedState !== result.oauthState) {
        yield* auth.clearOAuthState(mcpName)
        throw new DuoduoError({ message: "OAuth state mismatch - potential CSRF attack", messageZh: "OAuth state 不匹配——潜在的 CSRF 攻击", cause: undefined })
      }
      yield* auth.clearOAuthState(mcpName)
      return yield* finishAuth(mcpName, code)
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (mcpName: string, authorizationCode: string) {
      const transport = pendingOAuthTransports.get(mcpName)
      if (!transport) throw new DuoduoError({ message: String(`No pending OAuth flow for MCP server: ${mcpName}`), messageZh: String(`MCP 服务 ${mcpName} 没有待处理的 OAuth 流程`), cause: undefined })

      const result = yield* Effect.tryPromise({
        try: () => transport.finishAuth(authorizationCode).then(() => true as const),
        catch: (error) => {
          log.error("failed to finish oauth", { mcpName, error })
          return new Cause.UnknownError(error)
        },
      }).pipe(Effect.option)

      if (Option.isNone(result)) {
        return { status: "failed", error: "OAuth completion failed" } as Status
      }

      yield* auth.clearCodeVerifier(mcpName)
      pendingOAuthTransports.delete(mcpName)

      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return { status: "failed", error: "MCP config not found after auth" } as Status

      return yield* createAndStore(mcpName, mcpConfig)
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      yield* auth.remove(mcpName)
      McpOAuthCallback.cancelPending(mcpName)
      pendingOAuthTransports.delete(mcpName)
      log.info("removed oauth credentials", { mcpName })
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return false
      return mcpConfig.type === "remote" && mcpConfig.oauth !== false
    })

    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      return !!entry?.tokens
    })

    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      if (!entry?.tokens) return "not_authenticated" as AuthStatus
      const expired = yield* auth.isTokenExpired(mcpName)
      return (expired ? "expired" : "authenticated") as AuthStatus
    })

    return Service.of({
      status,
      clients,
      tools,
      prompts,
      resources,
      add,
      connect,
      disconnect,
      getPrompt,
      readResource,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

// --- Per-service runtime ---

export const defaultLayer = layer.pipe(
  Layer.provide(McpAuth.layer),
  Layer.provide(Bus.layer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as MCP from "."
