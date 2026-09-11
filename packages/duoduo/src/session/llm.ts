import { DuoduoError } from "@/util/error"
import { Provider } from "@/provider"
import { Log } from "@/util"
import { Context, Effect, Layer, Record } from "effect"
import * as Stream from "effect/Stream"
import { type LanguageModelUsage, type ModelMessage, type Tool, tool, jsonSchema } from "ai"
import { mergeDeep, pipe } from "remeda"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider"
import { Config } from "@/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { context, propagation } from "@opentelemetry/api"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard } from "@/util"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { Installation } from "@/installation"
import { InstallationVersion } from "@/installation/version"
import { EffectBridge } from "@/effect"
import * as Option from "effect/Option"
import { resolveSmartLayerConnection } from "@/smart-layer"

const log = Log.create({ service: "llm" })
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

export type StreamInput = {
  user: MessageV2.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: Permission.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export type Event =
  | { type: "start" }
  | { type: "start-step" }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "reasoning-end"; id: string }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; text: string }
  | { type: "text-end"; id: string }
  | { type: "tool-input-start"; toolName: string; id: string }
  | { type: "tool-input-delta"; toolCallId: string; input: string }
  | { type: "tool-input-end"; toolCallId: string }
  | { type: "tool-call"; toolName: string; toolCallId: string; input: unknown; providerMetadata?: unknown }
  | { type: "tool-result"; toolCallId: string; output: unknown }
  | { type: "tool-error"; toolCallId: string; error: unknown }
  | { type: "finish-step"; finishReason: string; usage?: LanguageModelUsage }
  | { type: "finish"; usage?: LanguageModelUsage }
  | { type: "error"; error: Error }

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<Event, unknown, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/LLM") {}

export const live: Layer.Layer<
  Service,
  never,
  Auth.Service | Config.Service | Provider.Service | Permission.Service | SystemPrompt.Service
> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const config = yield* Config.Service
      const provider = yield* Provider.Service
      const perm = yield* Permission.Service

      const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
        const l = log
          .clone()
          .tag("providerID", input.model.providerID)
          .tag("modelID", input.model.id)
          .tag("session.id", input.sessionID)
          .tag("small", (input.small ?? false).toString())
          .tag("agent", input.agent.name)
          .tag("mode", input.agent.mode)
        const t0 = Date.now()
        l.info("stream", {
          modelID: input.model.id,
          providerID: input.model.providerID,
        })

        const [language, cfg, item, info, structuredCtx] = yield* Effect.all(
          [
            provider.getLanguage(input.model),
            config.get(),
            provider.getProvider(input.model.providerID),
            auth.get(input.model.providerID),
            // Super-RAG structured context — runs in parallel with provider init
            SystemPrompt.Service.use((svc) =>
              svc.structuredContext(
                input.sessionID,
                undefined, // phase: uses default "execute"
                (input.user as any)?.parts
                  ?.filter((p: any) => p.type === "text")
                  .map((p: any) => p.text)
                  .join("\n") ?? "",
                2000, // tokenBudget
                Instance.directory,
              ),
            ).pipe(
              Effect.catchCause((cause) => {
                l.warn("structuredContext failed", { cause: String(cause) })
                return Effect.void
              }),
            ),
          ],
          { concurrency: "unbounded" },
        )
        process.stderr.write(`[PERF] ${Date.now() - t0}ms: provider+structuredContext ready\n`)

        const isOpenaiOauth = Provider.isOpenaiOauth(item.id, info?.type)

        // Universal environment directives (concise-reply, project-context surfacing,
        // environment facts). Mirrors the Rust-runLoop path in prompt.ts so both paths
        // share one source of truth and never duplicate provider-txt instructions.
        const sysSvc = yield* SystemPrompt.Service
        // Locale already rides on the inbound user message (MessageV2.User.locale,
        // recorded by the frontend per message). Pass it through so the stream path
        // matches the Rust run-loop path (prompt.ts) and honours the program's UI
        // language. environment() falls back to message-language when locale is
        // absent, so this is a strict superset of prior behaviour — never a regression.
        const envLines = sysSvc.environment(input.model, { locale: input.user.locale })

        // A-class enhancement: inject local coding standards (AGENTS.md family) so the
        // stream path honours the team's rules. Remote URLs stay (main path only);
        // sub-agents exclude them (see decompose.ts) as a supply-chain guard.
        const codingStandards = yield* sysSvc.projectGuidance({ excludeRemoteUrls: false, includeSharedTypes: true })

        const system: string[] = []
        system.push(
          [
            // use agent prompt otherwise provider prompt
            ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
            // any custom prompt passed into this call
            ...input.system,
            // any custom prompt from last user message
            ...(input.user.system ? [input.user.system] : []),
            // universal environment directives (single source of truth)
            ...envLines,
            // local coding standards (AGENTS.md) — A-class enhancement
            ...(codingStandards ? [codingStandards] : []),
          ]
            .filter((x) => x)
            .join("\n"),
        )

        // Inject structured context into system prompt (fetched in parallel above)
        if (structuredCtx) {
          system.push(structuredCtx)
        }

        const header = system[0]!
        // rejoin to maintain 2-part structure for caching if header unchanged
        // `system[0] === header` is a tautology (header is read from system[0]
        // on the line above); dropped without behavior change.
        if (system.length > 2) {
          const rest = system.slice(1)
          system.length = 0
          system.push(header, rest.join("\n"))
        }

        const variant =
          !input.small && input.model.variants && input.user.model.variant
            ? (input.model.variants[input.user.model.variant] ?? {})
            : {}
        const base = input.small
          ? ProviderTransform.smallOptions(input.model)
          : ProviderTransform.options({
              model: input.model,
              sessionID: input.sessionID,
              providerOptions: item.options,
            })
        const options: Record<string, any> = pipe(
          base,
          mergeDeep(input.model.options),
          mergeDeep(input.agent.options),
          mergeDeep(variant),
        )
        // "Today's date" changes daily. It is appended as the LAST system
        // message (after all stable blocks) so the stable blocks keep a
        // byte-identical prompt-cache prefix across days. The marker
        // providerOptions.duoduo.noCache excludes it from cache_control
        // marking in ProviderTransform.applyCaching — Anthropic-family APIs
        // allow max 4 cache breakpoints (2 system + 2 final today; a 5th
        // would exceed the limit), and caching a daily line is pointless.
        const dateDirective = SystemPrompt.dateDirective()

        if (isOpenaiOauth) {
          options.instructions = [...system, dateDirective].join("\n")
        }

        const isWorkflow = language instanceof GitLabWorkflowLanguageModel
        let messages = isOpenaiOauth
          ? input.messages
          : isWorkflow
            ? input.messages
            : [
                ...system.map(
                  (x): ModelMessage => ({
                    role: "system",
                    content: x,
                  }),
                ),
                {
                  role: "system",
                  content: dateDirective,
                  providerOptions: { duoduo: { noCache: true } },
                } as ModelMessage,
                ...input.messages,
              ]

        // Apply ProviderTransform.message() — previously done inside wrapLanguageModel middleware.
        // This must happen before sending messages to Rust so that provider-specific
        // transformations (caching, providerOptions key remapping, etc.) are applied.
        messages = ProviderTransform.message(messages, input.model, options)

        const params = {
          // The model-level temperature is now a user-configured value (set when
          // adding/editing a model). When it is explicitly configured we always
          // send it, regardless of the `supports_temperature` capability flag —
          // that flag only gates the *fallback* default, since some providers
          // reject an unexpected `temperature` field. This is what lets e.g.
          // 商汤 token plan (which requires temperature=1) actually work.
          temperature:
            input.model.temperature !== undefined
              ? (input.agent.temperature ?? input.model.temperature)
              : input.model.capabilities.temperature
                ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
                : undefined,
          topP:
            input.model.topP !== undefined
              ? (input.agent.topP ?? input.model.topP)
              : (input.agent.topP ?? ProviderTransform.topP(input.model)),
          topK: ProviderTransform.topK(input.model),
          maxOutputTokens: ProviderTransform.maxOutputTokens(input.model),
          options,
        }
        const { headers } = { headers: {} }
        process.stderr.write(`[PERF] ${Date.now() - t0}ms: params ready\n`)

        const tools = resolveTools(input)

        // LiteLLM and some Anthropic proxies require the tools parameter to be present
        // when message history contains tool calls, even if no tools are being used.
        // Add a dummy tool that is never called to satisfy this validation.
        // This is enabled for:
        // 1. Providers with "litellm" in their ID or API ID (auto-detected)
        // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
        const isLiteLLMProxy =
          item.options?.["litellmProxy"] === true ||
          input.model.providerID.toLowerCase().includes("litellm") ||
          input.model.api.id.toLowerCase().includes("litellm")

        // LiteLLM/Bedrock rejects requests where the message history contains tool
        // calls but no tools param is present. When there are no active tools (e.g.
        // during compaction), inject a stub tool to satisfy the validation requirement.
        // The stub description explicitly tells the model not to call it.
        if (
          (isLiteLLMProxy || input.model.providerID.includes("github-copilot")) &&
          Object.keys(tools).length === 0 &&
          hasToolCalls(input.messages)
        ) {
          tools["_noop"] = tool({
            description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
            inputSchema: jsonSchema({
              type: "object",
              properties: {
                reason: { type: "string", description: "Unused" },
              },
            }),
            execute: async () => ({ output: "", title: "", metadata: {} }),
          })
        }

        // Wire up toolExecutor for DWS workflow models so that tool calls
        // from the workflow service are executed via duoduo's tool system
        // and results sent back over the WebSocket.
        if (language instanceof GitLabWorkflowLanguageModel) {
          const workflowModel = language as GitLabWorkflowLanguageModel & {
            sessionID?: string
            sessionPreapprovedTools?: string[]
            approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
          }
          workflowModel.sessionID = input.sessionID
          workflowModel.systemPrompt = system.join("\n")
          workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
            const t = tools[toolName]
            if (!t || !t.execute) {
              return { result: "", error: `Unknown tool: ${toolName}` }
            }
            try {
              const result = await t.execute(JSON.parse(argsJson), {
                toolCallId: _requestID,
                messages: input.messages,
                abortSignal: input.abort,
              })
              const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
              return {
                result: output,
                metadata: typeof result === "object" ? result?.metadata : undefined,
                title: typeof result === "object" ? result?.title : undefined,
              }
            } catch (e: any) {
              return { result: "", error: e.message ?? String(e) }
            }
          }

          const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
          workflowModel.sessionPreapprovedTools = Object.keys(tools).filter((name) => {
            const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
            return !match || match.action !== "ask"
          })

          const bridge = yield* EffectBridge.make()
          const approvedToolsForSession = new Set<string>()
          workflowModel.approvalHandler = Instance.bind(async (approvalTools) => {
            const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
            // Auto-approve tools that were already approved in this session
            // (prevents infinite approval loops for server-side MCP tools)
            if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
              return { approved: true }
            }

            const id = PermissionID.ascending()
            let unsub: (() => void) | undefined
            try {
              unsub = await Bus.subscribe(Permission.Event.Replied, (evt) => {
                if (evt.properties.requestID === id) void evt.properties.reply
              })
              const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
                try {
                  const parsed = JSON.parse(t.args) as Record<string, unknown>
                  const title = (parsed?.title ?? parsed?.name ?? "") as string
                  return title ? `${t.name}: ${title}` : t.name
                } catch {
                  return t.name
                }
              })
              const uniquePatterns = [...new Set(toolPatterns)] as string[]
              await bridge.promise(
                perm.ask({
                  id,
                  sessionID: SessionID.make(input.sessionID),
                  permission: "workflow_tool_approval",
                  patterns: uniquePatterns,
                  metadata: { tools: approvalTools },
                  always: uniquePatterns,
                  ruleset: [],
                }),
              )
              for (const name of uniqueNames) approvedToolsForSession.add(name)
              workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
              return { approved: true }
            } catch {
              return { approved: false }
            } finally {
              unsub?.()
            }
          })
        }

        // ── Build tool definitions for Rust ──────────────────────────────────
        // Convert the tools Record into the ToolDefinition[] format expected by
        // the Rust /agent/chat/stream endpoint.
        const toolDefs = Object.entries(tools).map(([name, t]) => ({
          type: "function" as const,
          function: {
            name,
            description: (t as any).description ?? "",
            parameters: (t as any).parameters ?? (t as any).inputSchema ?? { type: "object", properties: {} },
          },
        }))

        // ── Build extra_body from providerOptions ────────────────────────────
        // providerOptions are provider-specific params (e.g. Anthropic thinking,
        // Google thinkingConfig) that need to be merged into the request body.
        // The Rust side merges extra_body at the top level of the JSON.
        const providerOpts = ProviderTransform.providerOptions(input.model, params.options)

        // ── Build headers ────────────────────────────────────────────────────
        const requestHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          "x-session-id": input.sessionID,
          "x-session-affinity": input.sessionID,
          ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
          "User-Agent": `duoduo/${InstallationVersion}`,
          ...input.model.headers,
          ...headers,
        }

        // Authenticate against the Rust smart-layer. In desktop mode it is
        // spawned with DUO_SMART_LAYER_PASSWORD and `require_auth` rejects any
        // request without `Authorization: Basic`, so a bare URL is not enough
        // (P0-06). Same discovery chain as the SmartLayerClient.
        const smartLayerConn = resolveSmartLayerConnection()
        if (smartLayerConn?.authHeader) requestHeaders["Authorization"] = smartLayerConn.authHeader

        // Inject W3C trace context (traceparent/tracestate) so Rust sidecar
        // can continue the same trace. No-op when OTel is not configured.
        propagation.inject(context.active(), requestHeaders)

        process.stderr.write(`[PERF] ${Date.now() - t0}ms: calling Rust /agent/chat/stream\n`)

        // Return the assembled request context for the stream() function to consume.
        return {
          messages,
          model: input.model.api.id,
          temperature: params.temperature,
          topP: params.topP,
          topK: params.topK,
          maxOutputTokens: params.maxOutputTokens,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          toolChoice: input.toolChoice,
          extraBody: Object.keys(providerOpts).length > 0 ? providerOpts : undefined,
          headers: requestHeaders,
          sessionId: input.sessionID,
          abort: input.abort,
          retries: input.retries,
          toolsMap: tools,
        }
      })

      const stream: Interface["stream"] = (input) =>
        Stream.scoped(
          Stream.unwrap(
            Effect.gen(function* () {
              let sessionId: string | undefined

              const ctrl = yield* Effect.acquireRelease(
                Effect.sync(() => new AbortController()),
                (ctrl) =>
                  Effect.gen(function* () {
                    ctrl.abort()
                    // Best-effort: notify Rust side to cancel the LLM stream.
                    // This is a backup path — the primary path is abort → disconnect → CancelGuard drop.
                    // Same discovery chain as createSmartLayerClients: env
                    // first, then the URL file (P0-06 — bare env reads break
                    // on desktop launches where the sidecar spawned before
                    // smart-layer was ready), credentials included.
                    const smartLayerConn = resolveSmartLayerConnection()
                    if (smartLayerConn && sessionId) {
                      yield* Effect.tryPromise({
                        try: () =>
                          fetch(`${smartLayerConn.url}/agent/cancel/chat-${sessionId}`, {
                            method: "POST",
                            headers: smartLayerConn.authHeader
                              ? { Authorization: smartLayerConn.authHeader }
                              : undefined,
                          }).catch(() => undefined),
                        catch: () => undefined,
                      }).pipe(Effect.ignore)
                    }
                  }),
              )

              const startTime = Date.now()
              const req = yield* run({ ...input, abort: ctrl.signal })
              sessionId = req.sessionId

              // Resolve the Rust smart-layer URL via the shared discovery
              // chain (env first, then the well-known URL file). A bare env
              // read failed on desktop launches where smart-layer was not yet
              // ready when the sidecar spawned (P0-06).
              const smartLayerConn = resolveSmartLayerConnection()
              if (!smartLayerConn) {
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
                return yield* Effect.fail(new DuoduoError({ message: "Smart-layer URL unavailable (env and URL file) — cannot reach Rust LLM endpoint", messageZh: "智能层地址不可用（环境变量与发现文件均缺失）—— 无法连接 Rust LLM 端点", cause: undefined }))
              }
              const url = `${smartLayerConn.url}/agent/chat/stream`

              // Build the request body matching Rust ChatStreamRequest
              const body: Record<string, unknown> = {
                model: req.model,
                messages: req.messages,
                temperature: req.temperature,
                topK: req.topK,
                topP: req.topP,
                maxTokens: req.maxOutputTokens,
                tools: req.tools,
                toolChoice: req.toolChoice,
                extraBody: req.extraBody,
                sessionId: req.sessionId,
              }

              // Fetch with SSE response
// @effect-diagnostics-next-line globalErrorInEffectCatch:off
              const response = yield* Effect.tryPromise({
                try: () =>
                  fetch(url, {
                    method: "POST",
                    headers: req.headers,
                    body: JSON.stringify(body),
                    signal: ctrl.signal,
                  }),
                catch: (e) => (e instanceof Error ? e : new DuoduoError({ message: String(e), cause: e })),
              })

              if (!response.ok) {
                const text = yield* Effect.tryPromise({
                  try: () => response.text(),
                  catch: (e) => new DuoduoError({ message: String(e), cause: e }),
                })
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
                return yield* Effect.fail(new DuoduoError({ message: String(`Rust LLM endpoint HTTP ${response.status}: ${text}`), messageZh: String(`Rust LLM 端点 HTTP ${response.status}：${text}`), cause: undefined }))
              }

              const bodyStream = response.body
              if (!bodyStream) {
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
                return yield* Effect.fail(new DuoduoError({ message: "Rust LLM endpoint returned no body", messageZh: "Rust LLM 端点返回了空响应体", cause: undefined }))
              }

              // Parse the SSE stream from Rust, converting Rust events to AI SDK compatible events.
              const sseStream = parseSSEStream(bodyStream, req.toolsMap)

              return Stream.map(sseStream, (event) => {
                if (event.type === "finish-step") {
                  const stepUsage = event.usage
                  log.info("stream.complete", {
                    model: input.model.id,
                    providerID: input.model.providerID,
                    sessionID: input.sessionID,
                    latency: Date.now() - startTime,
                    finishReason: event.finishReason,
                    ...(stepUsage
                      ? {
                          tokens: {
                            input: stepUsage.inputTokens,
                            output: stepUsage.outputTokens,
                          },
                        }
                      : {}),
                  })
                }
                return event
              })
            }),
          ),
        )

      return Service.of({ stream })
    }),
  )

export const layer = Layer.suspend(() => live.pipe(Layer.provide(Permission.defaultLayer)))

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Config.defaultLayer),
  ),
)

function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

// Check if messages contain any tool-call content
// Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// SSE Stream Parser
// ---------------------------------------------------------------------------

/**
 * Parse a ReadableStream<Uint8Array> of SSE events from the Rust
 * `/agent/chat/stream` endpoint into an Effect.Stream<Event>.
 *
 * Rust SSE events:
 *   - `thinking` → { content: string }
 *   - `delta`     → { content: string }
 *   - `done`      → LlmResponse (camelCase JSON)
 *   - `error`     → { message: string }
 *
 * AI SDK fullStream events we synthesize:
 *   - reasoning-start / reasoning-delta / reasoning-end
 *   - text-delta
 *   - tool-input-start / tool-call
 *   - finish-step / finish
 *   - error
 */
export function parseSSEStream(
  bodyStream: ReadableStream<Uint8Array>,
  toolsMap: Record<string, Tool>,
): Stream.Stream<Event, Error> {
  // State for boundary event synthesis — shared across chunks via closure.
  // These are mutated inside mapChunk and read in the finally block.
  const state = { reasoningStarted: false, reasoningId: "", textStarted: false, started: false }

  const reader = bodyStream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  // `currentEvent`/`currentData` persist across chunk reads: an SSE event's
  // `event:` and `data:` lines may arrive in separate network frames, so they
  // must accumulate until the terminating blank line, not reset per chunk.
  let currentEvent = ""
  let currentData = ""

  // Async iterator that reads SSE lines from the stream
  async function* readSSELines(): AsyncGenerator<Event> {
    try {
      while (true) {
        // LLM-01: a disconnect mid-stream (network blip / server timeout) is
        // captured here. Instead of silently dropping the partial response, we
        // flush the trailing buffer, close any open boundaries, and surface a
        // recoverable error carrying the partial tail so the caller can retry
        // / resume rather than discard everything.
        const read = await reader
          .read()
          .catch((err) => ({ __interrupted: true as const, err }))
        if ("__interrupted" in read) {
          const trimmed = buffer.trim()
          if (trimmed.startsWith("data:")) {
            try {
              const events = mapChunk("delta", trimmed.slice(5).trim(), toolsMap, state)
              for (const ev of events) yield ev
            } catch {
              // corrupted trailing frame — best-effort only
            }
          }
          if (state.reasoningStarted) yield { type: "reasoning-end", id: state.reasoningId }
          if (state.textStarted) yield { type: "text-end", id: crypto.randomUUID() }
          throw new DuoduoError({
            message: `LLM 流式响应中断（网络抖动或服务端超时），已接收的部分响应已保留。${trimmed ? `尾部数据: ${trimmed.slice(0, 200)}` : ""}`,
            cause: read.err instanceof Error ? read.err : undefined,
          })
        }
        const { done, value } = read
        if (done) break

        buffer += decoder.decode(value ?? new Uint8Array(), { stream: true })
        const lines = buffer.split("\n")
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim()
          } else if (line.startsWith("data:")) {
            currentData = line.slice(5).trim()
          } else if (line === "") {
            // Empty line = end of SSE event
            if (currentEvent && currentData) {
              // Emit start/start-step on first SSE event
              if (!state.started) {
                state.started = true
                yield { type: "start" }
                yield { type: "start-step" }
              }
              const events = mapChunk(currentEvent, currentData, toolsMap, state)
              for (const ev of events) yield ev
            }
            currentEvent = ""
            currentData = ""
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        const remaining = buffer.trim()
        if (remaining.startsWith("data:")) {
          const data = remaining.slice(5).trim()
          const events = mapChunk("delta", data, toolsMap, state)
          for (const ev of events) yield ev
        }
      }

      // Emit close events if still open
      if (state.reasoningStarted) yield { type: "reasoning-end", id: state.reasoningId }
      if (state.textStarted) yield { type: "text-end", id: crypto.randomUUID() }
    } finally {
      reader.releaseLock()
    }
  }

  return Stream.fromAsyncIterable(readSSELines(), (e) => (e instanceof Error ? e : new DuoduoError({ message: String(e), cause: undefined })))
}

/**
 * Map a single Rust SSE chunk to one or more AI SDK compatible events.
 * Uses the outer closure's `reasoningStarted`/`textStarted` state for
 * boundary event synthesis.
 */
export function mapChunk(
  eventType: string,
  data: string,
  toolsMap: Record<string, Tool>,
  state: { reasoningStarted: boolean; reasoningId: string; textStarted: boolean },
): Event[] {
  const events: Event[] = []

  try {
    if (eventType === "thinking") {
      const parsed = JSON.parse(data) as { content: string }
      if (!state.reasoningStarted) {
        state.reasoningId = crypto.randomUUID()
        events.push({ type: "reasoning-start", id: state.reasoningId })
        state.reasoningStarted = true
      }
      events.push({ type: "reasoning-delta", id: state.reasoningId, text: parsed.content })
    } else if (eventType === "delta") {
      const parsed = JSON.parse(data) as { content: string }
      if (state.reasoningStarted) {
        events.push({ type: "reasoning-end", id: state.reasoningId })
        state.reasoningStarted = false
      }
      if (!state.textStarted) {
        events.push({ type: "text-start", id: crypto.randomUUID() })
        state.textStarted = true
      }
      events.push({ type: "text-delta", text: parsed.content })
    } else if (eventType === "done") {
      const parsed = JSON.parse(data) as {
        content?: string
        reasoningContent?: string
        modelId?: string
        tokenUsage?: { promptTokens: number; completionTokens: number }
        finishReason?: string
        toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>
      }
      // Close any open boundaries
      if (state.reasoningStarted) {
        events.push({ type: "reasoning-end", id: state.reasoningId })
        state.reasoningStarted = false
      }
      if (state.textStarted) {
        events.push({ type: "text-end", id: crypto.randomUUID() })
        state.textStarted = false
      }
      // Emit tool-call events from done payload
      if (parsed.toolCalls && parsed.toolCalls.length > 0) {
        for (const tc of parsed.toolCalls) {
          events.push({ type: "tool-input-start", toolName: tc.function.name, id: tc.id })
          // Repair tool call: lower-case matching for case-insensitive tool names
          // If the tool name doesn't match any known tool, try lower-case version.
          // If still no match, mark as "invalid" so processor can handle it gracefully.
          let toolName = tc.function.name
          const lower = toolName.toLowerCase()
          let input: unknown
          if (toolsMap[toolName]) {
            // Exact match — parse arguments normally
            try {
              input = JSON.parse(tc.function.arguments)
            } catch {
              input = tc.function.arguments
            }
          } else if (lower !== toolName && toolsMap[lower]) {
            // Case-insensitive match — repair to lower-case
            toolName = lower
            try {
              input = JSON.parse(tc.function.arguments)
            } catch {
              input = tc.function.arguments
            }
          } else {
            // No match — mark as "invalid" with error info
            toolName = "invalid"
            input = { tool: tc.function.name, error: `Unknown tool: ${tc.function.name}` }
          }
          events.push({ type: "tool-call", toolName, toolCallId: tc.id, input })
        }
      }
      // Emit finish-step. The Rust endpoint only reports prompt/completion tokens,
      // so the rest of LanguageModelUsage is left to getTokens' fallbacks. The full
      // (AI SDK native) usage shape flows through this same field without narrowing.
      const toUsage = (tu: { promptTokens: number; completionTokens: number }): LanguageModelUsage =>
        ({
          inputTokens: tu.promptTokens,
          outputTokens: tu.completionTokens,
          totalTokens: tu.promptTokens + tu.completionTokens,
          inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: tu.promptTokens },
          outputTokenDetails: { reasoningTokens: 0 },
        }) as LanguageModelUsage
      events.push({
        type: "finish-step",
        finishReason: parsed.finishReason ?? "stop",
        usage: parsed.tokenUsage ? toUsage(parsed.tokenUsage) : undefined,
      })
      events.push({
        type: "finish",
        usage: parsed.tokenUsage ? toUsage(parsed.tokenUsage) : undefined,
      })
    } else if (eventType === "error") {
      const parsed = JSON.parse(data) as {
        message: string
        retryable?: boolean
        retry_after_ms?: number
      }
      if (state.reasoningStarted) {
        events.push({ type: "reasoning-end", id: state.reasoningId })
        state.reasoningStarted = false
      }
      if (state.textStarted) {
        events.push({ type: "text-end", id: crypto.randomUUID() })
        state.textStarted = false
      }
      events.push({
        type: "error",
        error: new DuoduoError({
          message: String(parsed.message),
          retryable:
            typeof parsed.retryable === "boolean" ? parsed.retryable : undefined,
          retry_after_ms:
            typeof parsed.retry_after_ms === "number" && parsed.retry_after_ms > 0
              ? parsed.retry_after_ms
              : undefined,
          cause: undefined,
        }),
      })
    }
  } catch (e) {
    events.push({ type: "error", error: e instanceof Error ? e : new DuoduoError({ message: String(e), cause: undefined }) })
  }

  return events
}

export * as LLM from "./llm"
