import { DuoduoError } from "@/util/error"
import { t as i18n } from "@/util/locale"
import path from "path"
import os from "os"
import z from "zod"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Log } from "../util"
import { SessionRevert } from "./revert"
import * as Session from "./session"
import { Agent } from "../agent/agent"
import { Provider } from "../provider"
import { ModelID, ProviderID } from "../provider/schema"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { SessionCompaction } from "./compaction"
import { persistDiscoveredOutputLimit, getDiscoveredOutputLimit } from "./overflow"
import { Bus } from "../bus"
import { ProviderTransform } from "../provider"
import { SystemPrompt, provider as systemPromptProvider } from "./system"
import { SessionCompletion } from "./completion"
import { Instruction } from "./instruction"

import PROMPT_PLAN from "../session/prompt/plan.txt"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import { ToolRegistry } from "../tool"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { Hash } from "@duoduo-ai/shared/util/hash"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { ConfigMarkdown, Config } from "../config"
import { SessionSummary } from "./summary"
import { NamedError } from "@duoduo-ai/shared/util/error"
import { Tool } from "@/tool"
import { Permission } from "@/permission"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@/shell/shell"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { Truncate } from "@/tool"
import { decodeDataUrl } from "@/util/data-url"
import { Database } from "../storage"
import { MessageTable } from "./session.sql"
import { Process } from "@/util"
import { Cause, Effect, Exit, Layer, Option, Scope, Context, Schedule } from "effect"
import { EffectLogger } from "@/effect"
import { InstanceState } from "@/effect"
import { Instance } from "@/project/instance"
import { type TaskPromptOps } from "@/tool/task"
import { Todo } from "@/session/todo"
import { snapshotGitDir } from "../snapshot"
import { SessionRunState } from "./run-state"
import { EffectBridge } from "@/effect"
import {
  setCascadeQA,
  setCascadeQAGlobal,
  deleteCascadeQA,
  onSessionDeleted,
} from "./cascade-qa-registry"
import { createSmartLayerClients, decomposeTask } from "@/smart-layer"
import type { SubTaskRequest } from "@/smart-layer"
import { setPromptID, deletePromptID } from "./prompt-id-registry"
import { analyzeAstOperationImpact, type ImpactGraph } from "@/plan/impact-analysis"
import { collectPlanEntityIds, entitySearchName, matchPlanCandidates } from "@/plan/plan-match"

// Lazy-import AppRuntime to avoid circular dependency (same pattern as Bus.publish).
let _appRuntime: typeof import("@/effect/app-runtime").AppRuntime | undefined
async function getAppRuntime() {
  if (!_appRuntime) {
    try {
      const mod = await import("@/effect/app-runtime")
      _appRuntime = mod.AppRuntime
    } catch {
      return undefined
    }
  }
  return _appRuntime
}

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

type SmartLayerClients = NonNullable<ReturnType<typeof createSmartLayerClients>>

function promptLooksLikeCodeWrite(text: string): boolean {
  const lower = text.toLowerCase()
  return [
    "修改",
    "修复",
    "实现",
    "新增",
    "重构",
    "删除",
    "改成",
    "写入",
    "edit",
    "fix",
    "implement",
    "add",
    "refactor",
    "delete",
    "update",
  ].some((keyword) => lower.includes(keyword))
}

function multiAgentMode() {
  const value = String(Flag.DUODUO_MULTI_AGENT_MODE ?? "adaptive").toLowerCase()
  return value === "off" || value === "fixed4" ? value : "adaptive"
}

function orchestrationPlanForPrompt(text: string, mode: "adaptive" | "fixed4") {
  if (mode === "fixed4") {
    return {
      mode,
      level: "complex",
      stages: ["retriever", "planner", "validator", "executor"],
      requiresValidation: true,
      status: "planned",
      reason: ["fixed4 mode"],
    }
  }
  const complex = ["重构", "架构", "迁移", "多模块", "refactor", "architecture", "migration"].some((keyword) =>
    text.toLowerCase().includes(keyword),
  )
  const medium =
    complex ||
    ["多个文件", "依赖", "方案", "multi-file", "dependency", "plan"].some((keyword) =>
      text.toLowerCase().includes(keyword),
    )
  return {
    mode,
    level: complex ? "complex" : medium ? "medium" : "simple",
    stages: complex
      ? ["retriever", "planner", "validator", "executor"]
      : medium
        ? ["retriever", "planner", "executor"]
        : ["planner", "executor"],
    requiresValidation: complex,
    status: "planned",
    reason: complex
      ? ["complex code-writing task"]
      : medium
        ? ["medium code-writing task"]
        : ["simple code-writing task"],
  }
}

function autoSubtasksForPrompt(text: string, mode: "adaptive" | "fixed4"): MessageV2.SubtaskPartInput[] {
  const plan = orchestrationPlanForPrompt(text, mode)
  const subtasks: MessageV2.SubtaskPartInput[] = []
  if (plan.stages.includes("retriever")) {
    subtasks.push({
      type: "subtask",
      agent: "explore",
      description: "Retrieve context",
      prompt: [
        "Read blackboard key plan_candidates first.",
        "Explore only the relevant files, symbols, KG/memory hints, and risks for this task.",
        "Write durable findings back with blackboard_write. Do not edit files.",
        "User task:",
        text,
      ].join("\n"),
      command: "multi-agent-retriever",
    })
  }
  if (plan.stages.includes("planner")) {
    subtasks.push({
      type: "subtask",
      agent: "plan",
      description: "Plan implementation",
      prompt: [
        "Read blackboard plan_candidates and retriever findings if present.",
        "Produce a concise implementation plan, expected files, risks, and whether validation is required.",
        "Write the result to blackboard_write key=implementation_plan. Do not edit product files.",
        "User task:",
        text,
      ].join("\n"),
      command: "multi-agent-planner",
    })
  }
  if (plan.stages.includes("validator")) {
    subtasks.push({
      type: "subtask",
      agent: "review",
      description: "Validate plan",
      prompt: [
        "Read blackboard implementation_plan, impactAnalysis, lspReferences, and plan_candidates.",
        "Validate whether the plan is safe to execute. Do not edit files.",
        'If safe, write blackboard_write key=validation_result with JSON {"status":"passed","files":[...],"checkedAt":Date.now()}. If unsafe, write status failed and issues.',
        "User task:",
        text,
      ].join("\n"),
      command: "multi-agent-validator",
    })
  }
  return subtasks
}

function multiAgentReminderText(mode: "adaptive" | "fixed4") {
  const stages =
    mode === "fixed4"
      ? "Use the full Retriever -> Planner -> Validator -> Executor flow for code-writing tasks."
      : "Use at least Planner -> Executor for code-writing tasks; add Retriever and Validator when plan candidates, KG impact, or multi-file risk exists."
  return [
    "<system-reminder>",
    "Multi-agent blackboard workflow is enabled for this code-writing task.",
    stages,
    "Use blackboard_find/read/write to reuse plan_candidates, preferences, impactAnalysis, and lspSymbols before editing.",
    "Retriever/Planner/Validator agents must not write files. Executor should execute the validated plan and avoid re-exploration unless required.",
    "</system-reminder>",
  ].join("\n")
}

async function collectReadOnlyPlanImpact(clients: SmartLayerClients, candidates: unknown[]): Promise<ImpactGraph[]> {
  const entityIds = collectPlanEntityIds(candidates)
  const result: ImpactGraph[] = []
  for (const entityId of entityIds) {
    try {
      const graph = await clients.graph.neighborsWithEdges(entityId, Instance.directory)
      result.push({
        entityId,
        nodes: graph.nodes.slice(0, 10),
        edges: graph.edges.slice(0, 20),
      })
    } catch {
      // KG impact analysis is advisory only.
    }
  }
  return result
}

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

const log = Log.create({ service: "session.prompt" })
const elog = EffectLogger.create({ service: "session.prompt" })

// Sessions for which an abort was requested via SessionPrompt.cancel.
// The rustRunLoopPoll loop checks this each iteration and returns promptly,
// because the run fiber is NOT registered in SessionRunState (so Fiber.interrupt
// cannot reach it). Zero-risk: only adds an early-return on explicit abort; the
// happy path never touches this set. Cleared when a new run starts for the
// session (see delegateToRustRunLoop) so a later prompt is not affected.
const abortedSessions = new Set<string>()

// [L-04] In-flight delegated-tool AbortControllers, keyed by sessionID. When
// the user cancels (SessionPrompt.cancel), every in-flight delegated tool for
// that session receives an abort signal immediately — so the poll loop's
// forEach settles promptly (each tool's catchCause path persists an error
// result to the DB) instead of blocking on the 5-minute fuse before the
// abort early-return in rustRunLoopPoll can fire.
const inflightToolAborts = new Map<string, Set<AbortController>>()

export { setCascadeQA, setCascadeQAGlobal, onSessionDeleted } from "./cascade-qa-registry"

export interface Interface {
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void, unknown, unknown>
  readonly prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts, unknown, unknown>
  readonly runAgentTurn: (input: z.infer<typeof AgentTurnInput>) => Effect.Effect<MessageV2.WithParts, unknown, unknown>
  readonly shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts, unknown, unknown>
  readonly command: (input: CommandInput) => Effect.Effect<MessageV2.WithParts, unknown, unknown>
  readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"], unknown, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/SessionPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const cfgService = yield* Config.Service
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service
    const provider = yield* Provider.Service
    const compaction = yield* SessionCompaction.Service
    const commands = yield* Command.Service
    const permission = yield* Permission.Service
    const fsys = yield* AppFileSystem.Service
    const mcp = yield* MCP.Service
    const lsp = yield* LSP.Service
    const registry = yield* ToolRegistry.Service
    const truncate = yield* Truncate.Service
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const scope = yield* Scope.Scope
    const instruction = yield* Instruction.Service
    const state = yield* SessionRunState.Service
    const revert = yield* SessionRevert.Service
    const summary = yield* SessionSummary.Service
    const sys = yield* SystemPrompt.Service
    const llm = yield* LLM.Service
    const completion = yield* SessionCompletion.Service
    const runner = Effect.fn("SessionPrompt.runner")(function* () {
      return yield* EffectBridge.make()
    })
    const ops = Effect.fn("SessionPrompt.ops")(function* () {
      const run = yield* runner()
      return {
        cancel: (sessionID: SessionID) => run.fork(cancel(sessionID)),
        resolvePromptParts: (template: string) => resolvePromptParts(template),
        prompt: (input: PromptInput) => prompt(input),
      } satisfies TaskPromptOps
    })

    // cascadeQA cleanup: Instead of subscribing to the Bus at
    // layer-construction time (which requires InstanceState and breaks
    // tests that build this layer outside a per-instance scope), we
    // register a deletion callback via cascade-qa-registry.ts.
    // session.ts calls triggerOnDelete from Session.remove, which
    // invokes all registered callbacks — no circular dependency.
    onSessionDeleted((sessionID) => {
      deleteCascadeQA(sessionID)
    })

    const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
      yield* elog.info("cancel", { sessionID })
      // Signal the poll loop to terminate promptly. The run fiber is not
      // registered in SessionRunState, so Fiber.interrupt cannot reach it;
      // this flag is the reliable stop signal for rustRunLoopPoll.
      abortedSessions.add(sessionID)
      // [L-04] Abort every in-flight delegated tool for this session so its
      // execution settles (error result persisted via catchCause) instead of
      // running to the 5-minute fuse after the user clicked STOP.
      const inflight = inflightToolAborts.get(sessionID)
      if (inflight) {
        for (const controller of inflight) controller.abort()
      }
      yield* state.cancel(sessionID)
    })

    const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
      const ctx = yield* InstanceState.context
      const parts: PromptInput["parts"] = [{ type: "text", text: template }]
      const files = ConfigMarkdown.files(template)
      const seen = new Set<string>()
      yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (match) {
          const name = match[1]!
          if (seen.has(name)) return
          seen.add(name)
          const filepath = name.startsWith("~/")
            ? path.join(os.homedir(), name.slice(2))
            : path.resolve(ctx.worktree, name)

          const info = yield* fsys.stat(filepath).pipe(Effect.option)
          if (Option.isNone(info)) {
            const found = yield* agents.get(name)
            if (found) parts.push({ type: "agent", name: found.name })
            return
          }
          const stat = info.value
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
          })
        }),
        { concurrency: "unbounded", discard: true },
      )
      return parts
    })

    const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
      session: Session.Info
      history: MessageV2.WithParts[]
      providerID: ProviderID
      modelID: ModelID
    }) {
      if (globalThis.process?.env?.NODE_ENV === "test") return
      if (input.session.parentID) return
      if (!Session.isDefaultTitle(input.session.title)) return

      const real = (m: MessageV2.WithParts) =>
        m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
      const idx = input.history.findIndex(real)
      if (idx === -1) return

      const firstUser = input.history[idx]
      if (!firstUser || firstUser.info.role !== "user") return

      // 立即用首条用户消息（截断）作为占位标题，让侧栏马上显示可读标题；
      // 后续 LLM 生成成功时会在同一 run 内覆盖此占位（仅当恰好一条真实用户消息时生成）。
      const placeholderRaw = firstUser.parts
        .flatMap((p) => {
          if (p.type === "text" && !p.synthetic) return [p.text]
          if (p.type === "subtask") return [p.prompt]
          return []
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
      if (placeholderRaw) {
        const placeholder = placeholderRaw.length > 100 ? placeholderRaw.slice(0, 97) + "..." : placeholderRaw
        yield* sessions
          .setTitle({ sessionID: input.session.id, title: placeholder })
          .pipe(Effect.catchCause((cause) => elog.error("failed to set placeholder title", { error: Cause.squash(cause) })))
      }

      if (input.history.filter(real).length !== 1) return

      const context = input.history.slice(0, idx + 1)
      const firstInfo = firstUser.info

      const subtasks = firstUser.parts.filter((p): p is MessageV2.SubtaskPart => p.type === "subtask")
      const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

      const ag = yield* agents.get("title")
      if (!ag) return
      const mdl = ag.model
        ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
        : ((yield* provider.getSmallModel(input.providerID)) ??
          (yield* provider.getModel(input.providerID, input.modelID)))
      const msgs = onlySubtasks
        ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
        : yield* MessageV2.toModelMessagesEffect(context, mdl)
      const text = yield* llm
        .stream({
          agent: ag,
          user: firstInfo,
          system: [],
          small: true,
          tools: {},
          model: mdl,
          sessionID: input.session.id,
          retries: 2,
          messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
        })
        .pipe(
          Stream.filter((e): e is Extract<LLM.Event, { type: "text-delta" }> => e.type === "text-delta"),
          Stream.map((e) => e.text),
          Stream.mkString,
          Effect.orDie,
        )
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return
      const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      yield* sessions
        .setTitle({ sessionID: input.session.id, title: t })
        .pipe(Effect.catchCause((cause) => elog.error("failed to generate title", { error: Cause.squash(cause) })))
    })

    const insertReminders = Effect.fn("SessionPrompt.insertReminders")(function* (input: {
      messages: MessageV2.WithParts[]
      agent: Agent.Info
      session: Session.Info
    }) {
      const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
      if (!userMessage) return input.messages

      if (!Flag.DUODUO_EXPERIMENTAL_PLAN_MODE) {
        if (input.agent.name === "plan") {
          userMessage.parts.push({
            id: PartID.ascending(),
            messageID: userMessage.info.id,
            sessionID: userMessage.info.sessionID,
            type: "text",
            text: PROMPT_PLAN,
            synthetic: true,
          })
        }
        const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
        if (wasPlan && input.agent.name === "build") {
          userMessage.parts.push({
            id: PartID.ascending(),
            messageID: userMessage.info.id,
            sessionID: userMessage.info.sessionID,
            type: "text",
            text: BUILD_SWITCH,
            synthetic: true,
          })
        }
        return input.messages
      }

      const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
      if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
        const plan = Session.plan(input.session)
        if (!(yield* fsys.existsSafe(plan))) return input.messages
        const part = yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`,
          synthetic: true,
        })
        userMessage.parts.push(part)
        return input.messages
      }

      if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

      const plan = Session.plan(input.session)
      const exists = yield* fsys.existsSafe(plan)
      if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
      const part = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${exists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
 - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
 - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
 - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
 - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`,
        synthetic: true,
      })
      userMessage.parts.push(part)
      return input.messages
    })

    const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput) {
      const ctx = yield* InstanceState.context
      const run = yield* runner()
      const session = yield* sessions.get(input.sessionID)
      if (session.revert) {
        yield* revert.cleanup(session)
      }
      const agent = yield* agents.get(input.agent)
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const model = input.model ?? agent.model ?? (yield* lastModel(input.sessionID))
      const { msg, part } = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const userMsg: MessageV2.User = {
            id: input.messageID ?? MessageID.ascending(),
            sessionID: input.sessionID,
            time: { created: Date.now() },
            role: "user",
            agent: input.agent,
            model: { providerID: model.providerID, modelID: model.modelID },
          }
          yield* sessions.updateMessage(userMsg)
          const userPart: MessageV2.Part = {
            type: "text",
            id: PartID.ascending(),
            messageID: userMsg.id,
            sessionID: input.sessionID,
            text: "The following tool was executed by the user",
            synthetic: true,
          }
          yield* sessions.updatePart(userPart)

          const msg: MessageV2.Assistant = {
            id: MessageID.ascending(),
            sessionID: input.sessionID,
            parentID: userMsg.id,
            mode: input.agent,
            agent: input.agent,

            path: { cwd: ctx.directory, root: ctx.worktree },
            time: { created: Date.now() },
            role: "assistant",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.modelID,
            providerID: model.providerID,
          }
          yield* sessions.updateMessage(msg)
          const part: MessageV2.ToolPart = {
            type: "tool",
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: input.sessionID,
            tool: "bash",
            callID: ulid(),
            state: {
              status: "running",
              time: { start: Date.now() },
              input: { command: input.command },
            },
          }
          yield* sessions.updatePart(part)
          return { msg, part }
        }),
      )

      const sh = Shell.preferred()
      const shellName = (
        process.platform === "win32" ? path.win32.basename(sh, ".exe") : path.basename(sh)
      ).toLowerCase()
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const safeCommand = JSON.stringify(input.command)
      const invocations: Record<string, { args: string[] }> = {
        nu: { args: ["-c", input.command] },
        fish: { args: ["-c", input.command] },
        zsh: {
          args: [
            "-l",
            "-c",
            `
              __oc_cwd=$PWD
              [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
              [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
              cd "$__oc_cwd"
              eval ${safeCommand}
            `,
          ],
        },
        bash: {
          args: [
            "-l",
            "-c",
            `
              __oc_cwd=$PWD
              shopt -s expand_aliases
              [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
              cd "$__oc_cwd"
              eval ${safeCommand}
            `,
          ],
        },
        cmd: { args: ["/c", input.command] },
        powershell: { args: ["-NoProfile", "-Command", input.command] },
        pwsh: { args: ["-NoProfile", "-Command", input.command] },
        "": { args: ["-c", input.command] },
      }

      const args = (invocations[shellName] ?? invocations[""]!).args
      const cwd = ctx.directory
      const shellEnv = { env: {} }

      const cmd = ChildProcess.make(sh, args, {
        cwd,
        extendEnv: true,
        env: { ...shellEnv.env, TERM: "dumb" },
        stdin: "ignore",
        forceKillAfter: "3 seconds",
      })

      let output = ""
      let aborted = false

      const finish = Effect.uninterruptible(
        Effect.gen(function* () {
          if (aborted) {
            output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
          }
          if (!msg.time.completed) {
            msg.time.completed = Date.now()
            yield* sessions.updateMessage(msg)
          }
          if (part.state.status === "running") {
            const truncated = yield* truncate.output(output, {}, agent)
            part.state = {
              status: "completed",
              time: { ...part.state.time, end: Date.now() },
              input: part.state.input,
              title: "",
              metadata: {
                output,
                description: "",
                truncated: truncated.truncated,
                ...(truncated.truncated ? { outputPath: truncated.outputPath } : {}),
              },
              output: truncated.content,
            }
            yield* sessions.updatePart(part)
          }
        }),
      )

      const exit = yield* Effect.gen(function* () {
        const handle = yield* spawner.spawn(cmd)
        yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
          Effect.sync(() => {
            output += chunk
            if (part.state.status === "running") {
              part.state.metadata = { output, description: "" }
              void run.fork(sessions.updatePart(part))
            }
          }),
        )
        yield* handle.exitCode
      }).pipe(
        Effect.scoped,
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            aborted = true
          }),
        ),
        Effect.orDie,
        Effect.ensuring(finish),
        Effect.exit,
      )

      if (Exit.isFailure(exit) && !aborted && !Cause.hasInterruptsOnly(exit.cause)) {
        return yield* Effect.failCause(exit.cause)
      }

      return { info: msg, parts: [part] }
    })

    const getModel = Effect.fn("SessionPrompt.getModel")(function* (
      providerID: ProviderID,
      modelID: ModelID,
      sessionID: SessionID,
    ) {
      const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return exit.value
      const err = Cause.squash(exit.cause)
      if (Provider.ModelNotFoundError.isInstance(err)) {
        const hint = err.data.suggestions?.length ? ` Did you mean: ${err.data.suggestions.join(", ")}?` : ""
        yield* bus.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({
            message: `Model not found: ${err.data.providerID}/${err.data.modelID}.${hint}`,
          }).toObject(),
        })
      }
      return yield* Effect.failCause(exit.cause)
    })

    const lastModel = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
      if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
      // No model was provided AND no historical user message carries one.
      // Fail loudly instead of silently falling back to a hardcoded default
      // model (provider.defaultModel) — that would burn tokens on an unintended
      // provider/model. The UI must always send the selected model.
      return yield* Effect.fail(
        new NamedError.Unknown({
          message: "No model selected. Please choose a model in the AI chat before sending.",
        }),
      )
    })

    const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
      const agentName = input.agent || (yield* agents.defaultAgent())
      const ag = yield* agents.get(agentName)
      if (!ag) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const model = input.model ?? ag.model ?? (yield* lastModel(input.sessionID))
      const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
      const full =
        !input.variant && ag.variant && same
          ? yield* provider.getModel(model.providerID, model.modelID).pipe(Effect.catchDefect(() => Effect.void))
          : undefined
      const variant = input.variant ?? (ag.variant && full?.variants?.[ag.variant] ? ag.variant : undefined)

      const info: MessageV2.User = {
        id: input.messageID ?? MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        tools: input.tools,
        agent: ag.name,
        model: {
          providerID: model.providerID,
          modelID: model.modelID,
          variant,
        },
        system: input.system,
        locale: input.locale,
        format: input.format,
      }

      yield* Effect.addFinalizer(() => instruction.clear(info.id))

      type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
      const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
        ...part,
        id: part.id ? PartID.make(part.id) : PartID.ascending(),
      })

      const resolvePart: (
        part: PromptInput["parts"][number],
      ) => Effect.Effect<Draft<MessageV2.Part>[], unknown, unknown> = Effect.fn("SessionPrompt.resolveUserPart")(
        function* (part) {
          if (part.type === "file") {
            if (part.source?.type === "resource") {
              const { clientName, uri } = part.source
              log.info("mcp resource", { clientName, uri, mime: part.mime })
              const pieces: Draft<MessageV2.Part>[] = [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Reading MCP resource: ${part.filename} (${uri})`,
                },
              ]
              const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
              if (Exit.isSuccess(exit)) {
                const content = exit.value
                if (!content) throw new DuoduoError({ message: String(`Resource not found: ${clientName}/${uri}`), messageZh: String(`资源未找到：${clientName}/${uri}`), cause: undefined })
                const items = Array.isArray(content.contents) ? content.contents : [content.contents]
                for (const c of items) {
                  if ("text" in c && c.text) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: c.text,
                    })
                  } else if ("blob" in c && c.blob) {
                    const mime = "mimeType" in c ? c.mimeType : part.mime
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary content: ${mime}]`,
                    })
                  }
                }
                pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
              } else {
                const error = Cause.squash(exit.cause)
                log.error("failed to read MCP resource", { error, clientName, uri })
                const message = error instanceof Error ? error.message : String(error)
                pieces.push({
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Failed to read MCP resource ${part.filename}: ${message}`,
                })
              }
              return pieces
            }
            const url = new URL(part.url)
            switch (url.protocol) {
              case "data:":
                if (part.mime === "text/plain") {
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
// @effect-diagnostics-next-line preferSchemaOverJson:off
                      text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                    },
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: decodeDataUrl(part.url),
                    },
                    { ...part, messageID: info.id, sessionID: input.sessionID },
                  ]
                }
                break
              case "file:": {
                log.info("file", { mime: part.mime })
                const filepath = fileURLToPath(part.url)
                if (yield* fsys.isDir(filepath)) part.mime = "application/x-directory"

                const { read } = yield* registry.named()
                const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) => {
                  const controller = new AbortController()
                  return read
                    .execute(args, {
                      sessionID: input.sessionID,
                      abort: controller.signal,
                      agent: input.agent!,
                      messageID: info.id,
                      extra: { bypassCwdCheck: true, ...extra },
                      messages: [],
                      metadata: () => Effect.void,
                      ask: () => Effect.void,
                    })
                    .pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
                }

                if (part.mime === "text/plain") {
                  let offset: number | undefined
                  let limit: number | undefined
                  const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                  if (range.start != null) {
                    const filePathURI = part.url.split("?")[0]
                    let start = parseInt(range.start)
                    let end = range.end ? parseInt(range.end) : undefined
                    if (start === end) {
                      const symbols = yield* lsp
                        .documentSymbol(filePathURI!)
                      for (const symbol of symbols) {
                        let r: LSP.Range | undefined
                        if ("range" in symbol) r = symbol.range
                        else if ("location" in symbol) r = symbol.location.range
                        if (r?.start?.line && r?.start?.line === start) {
                          start = r.start.line
                          end = r?.end?.line ?? start
                          break
                        }
                      }
                    }
                    offset = Math.max(start, 1)
                    if (end) limit = end - (offset - 1)
                  }
                  const args = { filePath: filepath, offset, limit }
                  const pieces: Draft<MessageV2.Part>[] = [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
// @effect-diagnostics-next-line preferSchemaOverJson:off
                      text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                    },
                  ]
                  const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                    Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                    Effect.exit,
                  )
                  if (Exit.isSuccess(exit)) {
                    const result = exit.value
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: result.output,
                    })
                    if (result.attachments?.length) {
                      pieces.push(
                        ...result.attachments.map((a) => ({
                          ...a,
                          synthetic: true,
                          filename: a.filename ?? part.filename,
                          messageID: info.id,
                          sessionID: input.sessionID,
                        })),
                      )
                    } else {
                      pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
                    }
                  } else {
                    const error = Cause.squash(exit.cause)
                    log.error("failed to read file", { error })
                    const message = error instanceof Error ? error.message : String(error)
                    yield* bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({ message }).toObject(),
                    })
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    })
                  }
                  return pieces
                }

                if (part.mime === "application/x-directory") {
                  const args = { filePath: filepath }
                  const exit = yield* execRead(args).pipe(Effect.exit)
                  if (Exit.isFailure(exit)) {
                    const error = Cause.squash(exit.cause)
                    log.error("failed to read directory", { error })
                    const message = error instanceof Error ? error.message : String(error)
                    yield* bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({ message }).toObject(),
                    })
                    return [
                      {
                        messageID: info.id,
                        sessionID: input.sessionID,
                        type: "text",
                        synthetic: true,
                        text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                      },
                    ]
                  }
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
// @effect-diagnostics-next-line preferSchemaOverJson:off
                      text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                    },
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: exit.value.output,
                    },
                    { ...part, messageID: info.id, sessionID: input.sessionID },
                  ]
                }

                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                  },
                  {
                    id: part.id,
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    url:
                      `data:${part.mime};base64,` +
                      Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                    mime: part.mime,
                    filename: part.filename!,
                    source: part.source,
                  },
                ]
              }
            }
          }

          if (part.type === "agent") {
            const perm = Permission.evaluate("task", part.name, ag.permission)
            const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
            return [
              { ...part, messageID: info.id, sessionID: input.sessionID },
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text:
                  " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                  part.name +
                  hint,
              },
            ]
          }

          return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
        },
      )

      const parts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
        Effect.map((x) => x.flat().map(assign)),
      )

      const mode = multiAgentMode()
      const promptText = input.parts
        .filter((part): part is MessageV2.TextPartInput => part.type === "text")
        .map((part) => part.text)
        .join("\n")
      const hasExplicitAgentParts = input.parts.some((part) => part.type === "agent" || part.type === "subtask")
      if (
        input.promptID &&
        input.blackboardOwner !== false &&
        mode !== "off" &&
        !hasExplicitAgentParts &&
        promptLooksLikeCodeWrite(promptText)
      ) {
        for (const subtask of autoSubtasksForPrompt(promptText, mode)) {
          parts.push(assign({ ...subtask, messageID: info.id, sessionID: input.sessionID }))
        }
      }
      if (mode !== "off" && promptLooksLikeCodeWrite(promptText)) {
        parts.push(
          assign({
            messageID: info.id,
            sessionID: input.sessionID,
            type: "text",
            synthetic: true,
            text: multiAgentReminderText(mode),
          }),
        )
      }

      const parsed = MessageV2.Info.zod.safeParse(info)
      if (!parsed.success) {
        log.error("invalid user message before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          agent: info.agent,
          model: info.model,
          issues: parsed.error.issues,
        })
      }
      parts.forEach((part, index) => {
        const p = MessageV2.Part.zod.safeParse(part)
        if (p.success) return
        log.error("invalid user part before save", {
          sessionID: input.sessionID,
          messageID: info.id,
          partID: part.id,
          partType: part.type,
          index,
          issues: p.error.issues,
          part,
        })
      })

      yield* sessions.updateMessage(info)
      for (const part of parts) yield* sessions.updatePart(part)

      return { info, parts }
    }, Effect.scoped)

    const writePlanCandidatesToBlackboard = Effect.fn("SessionPrompt.writePlanCandidatesToBlackboard")(function* (
      input: PromptInput,
    ) {
      if (!input.promptID) return
      const query = input.parts
        .filter((part): part is MessageV2.TextPartInput => part.type === "text")
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 4000)
      if (!query) return

      const ctx = yield* InstanceState.context
      const clients = createSmartLayerClients()
      if (!clients?.blackboard) return

      const currentMode = multiAgentMode()
      if (currentMode !== "off" && promptLooksLikeCodeWrite(query)) {
        yield* Effect.tryPromise({
          try: () =>
            clients.blackboard.write({
              promptId: input.promptID!,
              agentId: "system:orchestration",
              key: "orchestration_plan",
              value: JSON.stringify(orchestrationPlanForPrompt(query, currentMode), null, 2),
            }),
          catch: () => new DuoduoError({ message: "orchestration plan write failed", messageZh: "orchestration plan 写入失败", cause: undefined }),
        }).pipe(Effect.catch(() => Effect.void))
      }

      if (!clients.plan) return

      const candidates = yield* Effect.tryPromise({
        try: () => clients.plan.search({ query, projectPath: ctx.directory, limit: 5 }),
        catch: () => new DuoduoError({ message: "plan search failed", messageZh: "plan 搜索失败", cause: undefined }),
      }).pipe(Effect.catch(() => Effect.succeed(null)))

      const preferences = yield* Effect.tryPromise({
        try: () => clients.memory.getProfile("default", ctx.project.id),
        catch: () => new DuoduoError({ message: "memory profile unavailable", messageZh: "memory profile 不可用", cause: undefined }),
      }).pipe(Effect.catch(() => Effect.succeed([])))
      const planPreferences = preferences.filter(
        (entry) => entry.category === "preference" || entry.category === "rejected_plan",
      )

      const candidateList = candidates?.candidates ?? []
      const planMatch = matchPlanCandidates({
        query,
        candidates: candidateList,
        preferences: planPreferences.map((entry) => ({
          id: entry.id,
          category: entry.category,
          content: entry.content,
          metadata: entry.metadata,
        })),
      })
      const impactAnalysis = yield* Effect.tryPromise({
        try: () => collectReadOnlyPlanImpact(clients, candidateList),
        catch: () => new DuoduoError({ message: "plan impact analysis failed", messageZh: "plan 影响分析失败", cause: undefined }),
      }).pipe(Effect.catch(() => Effect.succeed([])))
      const operationImpact = analyzeAstOperationImpact({ candidates: candidateList, impactGraphs: impactAnalysis })

      const lspSymbols = yield* Effect.forEach(
        collectPlanEntityIds(candidateList),
        (entityId) =>
          lsp.workspaceSymbol(entitySearchName(entityId)).pipe(
            Effect.timeout("1 seconds"),
            Effect.catch(() => Effect.succeed([])),
            Effect.map((symbols) => ({ entityId, symbols: symbols.slice(0, 10) })),
          ),
        { concurrency: 2 },
      )

      const lspDetails = yield* Effect.forEach(
        collectPlanEntityIds(candidateList),
        (entityId) =>
          Effect.gen(function* () {
            const matches = yield* Effect.tryPromise({
              try: () =>
                clients.graph.search(entitySearchName(entityId), {
                  limit: 10,
                  projectPath: Instance.directory,
                }),
              catch: () => new DuoduoError({ message: "KG search failed", messageZh: "KG 搜索失败", cause: undefined }),
            }).pipe(Effect.catch(() => Effect.succeed([])))
            const node = matches.find((item) => item.id === entityId)
            const file = typeof node?.properties?.["file"] === "string" ? node.properties["file"] : undefined
            const startLine =
              typeof node?.properties?.["startLine"] === "number" ? node.properties["startLine"] : undefined
            if (!file || !startLine)
              return {
                entityId,
                references: [] as unknown[],
                definitions: [] as unknown[],
                implementations: [] as unknown[],
              }
            const loc = { file: path.join(ctx.directory, file), line: Math.max(0, startLine - 1), character: 0 }
            const [refs, definitions, implementations] = yield* Effect.all(
              [
                lsp.references(loc).pipe(
                  Effect.timeout("1 seconds"),
                  Effect.catch(() => Effect.succeed([])),
                ),
                lsp.definition(loc).pipe(
                  Effect.timeout("1 seconds"),
                  Effect.catch(() => Effect.succeed([])),
                ),
                lsp.implementation(loc).pipe(
                  Effect.timeout("1 seconds"),
                  Effect.catch(() => Effect.succeed([])),
                ),
              ],
              { concurrency: 3 },
            )
            return {
              entityId,
              references: refs.slice(0, 20),
              definitions: definitions.slice(0, 10),
              implementations: implementations.slice(0, 10),
            }
          }),
        { concurrency: 2 },
      )

      if (
        candidateList.length === 0 &&
        planPreferences.length === 0 &&
        planMatch.candidates.length === 0 &&
        impactAnalysis.length === 0 &&
        operationImpact.length === 0 &&
        lspSymbols.length === 0 &&
        lspDetails.every(
          (item) => item.references.length === 0 && item.definitions.length === 0 && item.implementations.length === 0,
        )
      ) {
        return
      }

      yield* Effect.tryPromise({
        try: () =>
          clients.blackboard.write({
            promptId: input.promptID!,
            agentId: "system:plan-search",
            key: "plan_candidates",
            value: JSON.stringify(
              {
                query,
                candidates: candidateList,
                planMatch,
                preferences: planPreferences.map((entry) => ({
                  id: entry.id,
                  category: entry.category,
                  content: entry.content,
                  metadata: entry.metadata,
                })),
                impactAnalysis,
                operationImpact,
                lspSymbols,
                lspReferences: lspDetails.map((item) => ({ entityId: item.entityId, references: item.references })),
                lspDefinitions: lspDetails.map((item) => ({ entityId: item.entityId, definitions: item.definitions })),
                lspImplementations: lspDetails.map((item) => ({
                  entityId: item.entityId,
                  implementations: item.implementations,
                })),
                note: "Read-only planning context. Do not execute automatically; use as planning context only.",
              },
              null,
              2,
            ),
          }),
        catch: () => new DuoduoError({ message: "blackboard plan_candidates write failed", messageZh: "blackboard plan_candidates 写入失败", cause: undefined }),
      }).pipe(Effect.catch(() => Effect.void))

      if (planMatch.candidates.length > 0) {
        yield* Effect.tryPromise({
          try: () =>
            clients.blackboard.write({
              promptId: input.promptID!,
              agentId: "system:plan-search",
              key: "plan_match",
              value: JSON.stringify(planMatch, null, 2),
            }),
          catch: () => new DuoduoError({ message: "blackboard plan_match write failed", messageZh: "blackboard plan_match 写入失败", cause: undefined }),
        }).pipe(Effect.catch(() => Effect.void))
      }
    })

    const prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts, unknown, unknown> = Effect.fn(
      "SessionPrompt.prompt",
    )(function* (input: PromptInput) {
      process.stderr.write(`[TRACE-prompt] ① prompt() called, sessionID=${input.sessionID}\n`)
      yield* elog.info("prompt: start", { sessionID: input.sessionID })
      const session = yield* sessions.get(input.sessionID)
      yield* revert.cleanup(session)
      const message = yield* createUserMessage(input)
      process.stderr.write(`[TRACE-prompt] ② userMessage created, messageID=${message.info.id}\n`)
      // 首条真实用户消息已落库：后台用其文本设置会话标题（占位），使侧栏立即显示可读标题
      // 而非自动生成的 "New session - <时间戳>"；恰好一条真实用户消息时还会用 LLM 生成正式标题覆盖占位。
      // forkDaemon 避免阻塞本次回复；placeholder 写入在前，LLM 覆盖在后。
      const userModel = (message.info as MessageV2.User).model
      yield* title({
        session,
        history: [message],
        providerID: userModel?.providerID ?? ("unknown" as ProviderID),
        modelID: userModel?.modelID ?? ("unknown" as ModelID),
      }).pipe(Effect.forkDetach)
      // Feishu-originated prompts pull the user back to this session on the
      // desktop (the user is away from the keyboard when Feishu drives the
      // conversation). Publish a focus hint the frontend navigates to.
      if (input.origin === "feishu") {
        void Bus.publish({ type: "session.focus" } as any, {
          sessionID: input.sessionID,
          origin: "feishu",
        })
      }
      yield* sessions.touch(input.sessionID)

      // Blackboard init (optional, per-prompt scope). Only the owner may init/destroy;
      // sub-agents sharing the same promptID are participants.
      const blackboardOwner = input.promptID ? input.blackboardOwner !== false : false
      if (input.promptID) {
        setPromptID(input.sessionID, input.promptID)
        const clients = createSmartLayerClients()
        if (blackboardOwner && clients?.blackboard) {
          yield* Effect.tryPromise({
            try: () =>
              clients.blackboard.init({
                sessionId: input.sessionID,
                promptId: input.promptID!,
              }),
            catch: () => new DuoduoError({ message: "blackboard init failed", messageZh: "blackboard 初始化失败", cause: undefined }),
          }).pipe(Effect.catch(() => Effect.void))
        }
        if (blackboardOwner) yield* writePlanCandidatesToBlackboard(input)
      }

      const permissions: Permission.Ruleset = []
      for (const [t, enabled] of Object.entries(input.tools ?? {})) {
        permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
      }
      if (permissions.length > 0) {
        session.permission = permissions
        yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
      }

      // Blackboard destroy effect (runs on all exit paths)
      const destroyBlackboard = input.promptID
        ? Effect.gen(function* () {
            deletePromptID(input.sessionID)
            if (!blackboardOwner) return
            yield* Effect.tryPromise({
              try: () => {
                const clients = createSmartLayerClients()
                if (!clients?.blackboard) return Promise.resolve()
                return clients.blackboard.destroy({ promptId: input.promptID! }).then(() => {})
              },
              catch: () => new DuoduoError({ message: "blackboard destroy failed", messageZh: "blackboard 销毁失败", cause: undefined }),
            }).pipe(Effect.catch(() => Effect.void))
          })
        : Effect.void

      if (input.noReply === true) {
        yield* destroyBlackboard
        return message
      }
      if (input.cascadeQA !== undefined) {
        setCascadeQA(input.sessionID, input.cascadeQA)
      }

      process.stderr.write(`[TRACE-prompt] ③ entering runAgentTurn\n`)
      yield* elog.info("prompt: entering runAgentTurn", { sessionID: input.sessionID })
      return yield* runAgentTurn({ sessionID: input.sessionID, autoAccept: input.autoAccept }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            process.stderr.write(
              `[TRACE-prompt] ⑧ runAgentTurn returned, role=${result.info.role}, finish=${(result.info as any).finish}\n`,
            )
          }),
        ),
        Effect.ensuring(destroyBlackboard),
      )
    })

    const lastAssistant = Effect.fnUntraced(function* (sessionID: SessionID) {
      const match = yield* sessions.findMessage(sessionID, (m) => m.info.role !== "user")
      if (Option.isSome(match)) return match.value
      const msgs = yield* sessions.messages({ sessionID, limit: 1 })
      if (msgs.length > 0) return msgs[0]!
      throw new DuoduoError({ message: "Impossible", messageZh: "不可能发生的情况", cause: undefined })
    })

    // Synthesize an assistant error message for runs that ended via Rust
    // `loop_error` WITHOUT producing one in the DB — e.g. an immediate LLM
    // HTTP 403 on step 0, where Rust only emits `LoopError` and breaks. The
    // poll loop calls this so it can return a valid result instead of spinning
    // to its budget. The returned message:
    //   • drives the existing UI error card (session-turn.tsx `error()` reads
    //     `info.error.name` / `info.error.data.message`),
    //   • flows through delegateToRustRunLoop's post-loop side effects (memory
    //     fork, compaction prune, overflow retry) without crashing,
    //   • is published to the frontend via `sessions.updateMessage` →
    //     `MessageV2.Event.Updated`, so the error card renders immediately.
    const createRunLoopErrorMessage = Effect.fn("SessionPrompt.createRunLoopErrorMessage")(
      function* (sessionID: SessionID, errMsg: string) {
        const ctx = yield* InstanceState.context
        const agentName = yield* agents.defaultAgent()
        const lastUser = yield* sessions.findMessage(sessionID, (m) => m.info.role === "user")
        const userMsg = Option.isSome(lastUser) ? (lastUser.value.info as MessageV2.User) : undefined
        const parentID = (userMsg?.id ?? MessageID.ascending()) as MessageID
        const agent = userMsg?.agent ?? agentName
        let providerID: ProviderID
        let modelID: ModelID
        if (userMsg?.model) {
          providerID = userMsg.model.providerID
          modelID = userMsg.model.modelID
        } else {
          const fallback = yield* lastModel(sessionID).pipe(
            Effect.orElseSucceed(() => ({
              providerID: "unknown" as ProviderID,
              modelID: "unknown" as ModelID,
            })),
          )
          providerID = fallback.providerID
          modelID = fallback.modelID
        }
        const msg: MessageV2.Assistant = {
          id: MessageID.ascending(),
          sessionID,
          parentID,
          mode: agent,
          agent,
          path: { cwd: ctx.directory, root: ctx.worktree },
          time: { created: Date.now() },
          role: "assistant",
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID,
          providerID,
          finish: "error",
          error: new NamedError.Unknown({ message: errMsg }).toObject() as MessageV2.Assistant["error"],
        }
        // Persist + surface the error to the frontend.
        //
        // In RUST_SINGLE_WRITE mode Rust never writes this synthesized message
        // (it only emitted `loop_error` and broke), and `sessions.updateMessage`
        // in that mode merely publishes on the lowercase `bus` (a SyncEvent)
        // which the frontend's global-sdk SSE filter drops — so the user would
        // see NOTHING. We therefore (a) write the row directly to the project
        // DB here (mirrors the fork path, which also writes directly because
        // Rust knows nothing about the message), and (b) publish on the capital
        // `Bus` whose payload type is "message.updated" — the only channel the
        // global SSE bridge actually delivers to the frontend (see
        // `ensureAssistantPlaceholder` for the same pattern).
        if (Flag.RUST_SINGLE_WRITE) {
          yield* Effect.sync(() => {
            const { id, sessionID: sid, ...rest } = msg
            Database.useProject((db) =>
              db
                .insert(MessageTable)
                .values({ id, session_id: sid, time_created: msg.time.created, data: rest })
                .onConflictDoUpdate({ target: MessageTable.id, set: { data: rest } })
                .run(),
            )
          })
        } else {
          // Non-RUST mode: SyncEvent.run persists the row (projectors write it).
          yield* sessions.updateMessage(msg)
        }
        // Bridge to the frontend in BOTH modes. The lowercase `bus`/SyncEvent
        // path is filtered out by global-sdk.tsx, so we must publish on the
        // capital `Bus` for the error card to render.
        yield* bus.publish(MessageV2.Event.Updated, { sessionID, info: msg })
        return { info: msg, parts: [] as MessageV2.Part[] }
      },
    )

    const lastAssistantSafe = Effect.fnUntraced(function* (sessionID: SessionID) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
        const found = msgs.findLast((m) => m.info.role === "assistant")
        if (found) return found
        yield* Effect.sleep("25 millis")
      }
      return yield* lastAssistant(sessionID)
    })

    /**
     * Execute a single pending tool part that Rust delegated to TS.
     *
     * When Rust's runLoop encounters a tool it cannot execute natively
     * (MCP, subtask, LSP, skill, plugin, permission-ask), it writes a
     * Pending tool part to the DB and suspends on `wait_for_tool_result`.
     * TS detects these pending parts, executes the tool, and POSTs
     * the result back to `/agent/tool_result` to unblock Rust.
     *
     * In RUST_SINGLE_WRITE mode, `sessions.updatePart` only publishes
     * SSE events (Rust handles DB persistence). We publish the state
     * transition (pending → running → completed/error) so the frontend
     * stays in sync. Rust writes the completed tool part to DB separately.
     */
    const executePendingToolPart = Effect.fnUntraced(function* (
      part: Extract<MessageV2.Part, { type: "tool" }>,
      sessionID: SessionID,
    ) {
      const clients = createSmartLayerClients()
      if (!clients) return

      const toolName = part.tool
      const callID = part.callID
      const partInput = part.state.status === "pending" ? part.state.input : {}
      const raw = part.state.status === "pending" ? part.state.raw : undefined

      // Resolve the permission ruleset from session + agent so that delegated
      // tools (MCP, bash, etc.) go through the same permission checks as tools
      // executed in the old TS runLoop path. Without this, ruleset was hardcoded
      // to [] and all permission rules were silently bypassed.
      const session = yield* sessions.get(sessionID)
      const lastUserMsg = yield* sessions.findMessage(sessionID, (m) => m.info.role === "user")
      const agentName = Option.isSome(lastUserMsg) ? lastUserMsg.value.info.agent : undefined
      const agent = agentName ? yield* agents.get(agentName) : undefined
      const permissionRuleset = Permission.merge(agent?.permission ?? [], session.permission ?? [])

      // Update part to running (SSE only — Rust writes DB)
      yield* sessions.updatePart({
        ...part,
        state: {
          status: "running",
          input: partInput,
          title: toolName,
          time: { start: Date.now() },
        },
      } satisfies MessageV2.ToolPart)

      // Execute the tool using TS-side tool registry or MCP
      //
      // NOTE(abort-signal): The AbortController below is NOT directly wired to
      // Rust's CancellationToken. When the Rust runLoop is cancelled, the TS
      // poll loop (rustRunLoopPoll) detects the finished assistant message and
      // exits naturally — but any in-flight tool execution will NOT receive an
      // abort signal. To prevent indefinite hangs, we wrap the entire tool
      // execution in a 5-minute timeout via Effect.race.
      const abortController = new AbortController()

      // [L-04] Register the controller so SessionPrompt.cancel can abort this
      // in-flight tool. Deregistered via Effect.ensuring on the execution pipe.
      let inflightSet = inflightToolAborts.get(sessionID)
      if (!inflightSet) {
        inflightSet = new Set<AbortController>()
        inflightToolAborts.set(sessionID, inflightSet)
      }
      inflightSet.add(abortController)

      // Resolve promptOps for tools that need it (e.g. TaskTool spawns a sub-agent
      // session via ops.prompt). ops() is defined in the SessionPrompt layer scope
      // but was never wired into executePendingToolPart — without this, the task
      // tool fails with "TaskTool requires promptOps in ctx.extra".
      const promptOps = yield* ops()

      const execStart = Date.now()
      const toolResult: string = yield* Effect.gen(function* (): Generator<Effect.Effect<any, any, any>, string, any> {
        // Try TS-side tool registry
        const toolDefs = yield* registry.tools({
          modelID: ModelID.make("default"),
          providerID: "default" as ProviderID,
          agent: (yield* agents.get("code")) ?? { name: "code" },
        })
        const toolDef = toolDefs.find((t) => t.id === toolName)

        if (toolDef?.execute) {
// @effect-diagnostics-next-line preferSchemaOverJson:off
          const args = raw ? (JSON.parse(raw) as Record<string, unknown>) : partInput
          const ctx: Tool.Context = {
            sessionID,
            abort: abortController.signal,
            messageID: part.messageID,
            callID,
            extra: { promptOps },
            agent: "code",
            messages: [],
            metadata: (val) =>
              sessions
                .updatePart({
                  ...part,
                  state: {
                    status: "running",
                    input: partInput,
                    title: val.title ?? toolName,
                    metadata: val.metadata ?? {},
                    time: { start: Date.now() },
                  },
                } satisfies MessageV2.ToolPart)
                .pipe(Effect.asVoid),
            ask: (req) =>
              permission
                .ask({
                  ...req,
                  sessionID,
                  tool: { messageID: part.messageID, callID },
                  ruleset: permissionRuleset,
                })
                .pipe(Effect.orDie),
          }
          const result = yield* toolDef.execute(args as any, ctx)
          return result.output
        }

        // Try MCP tools
        const mcpTools = yield* mcp.tools()
        const mcpTool = mcpTools[toolName]
        if (mcpTool?.execute) {
// @effect-diagnostics-next-line preferSchemaOverJson:off
          const args = raw ? (JSON.parse(raw) as Record<string, unknown>) : partInput
          const result = yield* Effect.promise(() =>
            mcpTool.execute!(
              args as any,
              {
                toolCallId: callID,
                abortSignal: abortController.signal,
                messages: [],
              } as any,
            ),
          )
          const textParts: string[] = []
          for (const c of (result as any).content ?? []) {
            if (c.type === "text") textParts.push(c.text)
            else if (c.type === "resource" && c.resource?.text) textParts.push(c.resource.text)
          }
          return textParts.join("\n\n")
        }

        return `Error: Tool '${toolName}' not found in TS registry`
      }).pipe(
        // 5-minute timeout: prevents indefinite hangs when abort signal is
        // not triggered (e.g. Rust runLoop cancelled but TS tool keeps running)
        Effect.raceFirst(
          Effect.sleep("5 minutes").pipe(
            Effect.flatMap(() => {
              abortController.abort()
              return Effect.fail(new DuoduoError({ message: "Tool execution timed out after 5 minutes", messageZh: "工具执行超时（超过 5 分钟）", cause: undefined }))
            }),
          ),
        ),
        Effect.catchCause((cause) => {
          const e = Cause.squash(cause)
          return Effect.succeed(`Error: ${e instanceof Error ? e.message : String(e)}`)
        }),
        // [L-04] Always deregister the in-flight controller — success, error,
        // timeout, or interruption — so the registry cannot leak controllers.
        Effect.ensuring(
          Effect.sync(() => {
            inflightSet.delete(abortController)
            if (inflightSet.size === 0) inflightToolAborts.delete(sessionID)
          }),
        ),
      )
      const execEnd = Date.now()
      log.info("delegated tool timing", {
        sessionID,
        tool: toolName,
        callID,
        phase: "execute",
        ms: execEnd - execStart,
      })

      // Truncate delegated tool output before sending to Rust, to prevent
      // large outputs (e.g. MCP tool results) from overflowing the LLM context.
      // Uses the same Truncate.Service as the old TS runLoop path.
      const truncated = yield* truncate.output(toolResult, {}, agent ?? undefined)
      const finalResult = typeof truncated === "string" ? truncated : truncated.content

      // POST result back to Rust runLoop to unblock wait_for_tool_result.
      // Retry on transient HTTP failure: the POST is idempotent (Rust dedups by
      // session_id+call_id in tool_registry.rs), so retries cannot double-apply.
      // Without this, a single failed POST would leave Rust blocked on
      // wait_for_tool_result for up to 10 minutes (tool_registry.rs internal
      // timeout) while the TS poll loop also runs to its 20-minute budget —
      // i.e. the session would appear hung even after clicking STOP.
      const postStart = Date.now()
      const postResult = Effect.tryPromise({
        try: () => clients.agent.postToolResult(sessionID, callID, finalResult),
        catch: (e) => new NamedError.Unknown({ message: `Failed to submit tool result: ${e}` }),
      })
      yield* postResult.pipe(Effect.retry(Schedule.recurs(3)))
      const postEnd = Date.now()
      log.info("delegated tool timing", {
        sessionID,
        tool: toolName,
        callID,
        phase: "post_result",
        ms: postEnd - postStart,
      })
    })

    /**
     * Poll DB while Rust runLoop is running. On each poll iteration:
     * 1. Check for Pending tool parts → execute them → POST result to Rust
     * 2. Check if the last assistant message has a finish field → return it
     *
     * This replaces the old lastAssistantSafe (80×25ms = 2s budget) which
     * was insufficient for multi-step agent loops that can run for minutes.
     *
     * There is no wall-clock budget: the poll runs until one of the explicit
     * termination signals below fires.
     */
    const rustRunLoopPoll = Effect.fnUntraced(function* (sessionID: SessionID) {
      // NO wall-clock budget. The old ~18min hard cutoff (2400 attempts) orphaned
      // legitimately long runs: TS released the session lock and set idle while
      // the Rust loop kept running, so the next prompt's run_loop registration
      // cancelled the orphan mid-flight ("LLM streaming request cancelled").
      // Termination is now provided by three explicit signals:
      //   1. abort flag (user stop) / sseDone (loop_done/loop_error) / DB
      //      finish=stop — same as before;
      //   2. liveness probe: GET /agent/metrics?session_id returns running:false
      //      once the Rust loop task exited (with a grace window to absorb the
      //      LoopDone→cleanup race);
      //   3. no-progress watchdog: if the DB layout (message/part counts) is
      //      unchanged for STUCK_THRESHOLD_MS, declare the loop stuck, cancel it,
      //      and synthesize a visible error message.
      const FAST_POLL_MS = 100 // First 30s: poll every 100ms
      const SLOW_POLL_MS = 500 // After 30s: poll every 500ms
      const FAST_PHASE_ATTEMPTS = 300 // 300 × 100ms = 30s
      const LIVENESS_PROBE_INTERVAL_MS = 30_000
      // How long running:false must persist before we conclude the loop exited
      // (absorbs the LoopDone-event → cleanup-removes-metrics race).
      const LIVENESS_GRACE_MS = 15_000
      // No DB progress for this long → stuck → cancel + visible error.
      const STUCK_THRESHOLD_MS = 30 * 60_000

      // Guard against re-executing the same delegated tool. Rust transitions the
      // pending part to completed once it receives our result, but a tool that
      // runs longer than one poll interval would otherwise be picked up again on
      // the next tick (its part is still `pending` in the DB). Tracking handled
      // callIDs makes delegated execution exactly-once within a single runLoop.
      const handledCallIDs = new Set<string>()

      // ── Snapshot the current last assistant message before polling ──
      // Without this, the poll would immediately find the PREVIOUS round's
      // assistant message (which already has finish=stop) and return it as
      // the result of the current round — a race condition that returns
      // stale data before Rust even starts the LLM call.
      const snapshotMsgs = yield* MessageV2.filterCompactedEffect(sessionID)
      const prevLastAssistantId = snapshotMsgs.findLast((m) => m.info.role === "assistant")?.info.id
      process.stderr.write(
        `[TRACE-poll] snapshot: prevLastAssistantId=${prevLastAssistantId ?? "none"}, totalMsgs=${snapshotMsgs.length}\n`,
      )

      // ── SSE subscription for zero-latency streaming ──
      // Subscribe to Rust runLoop events in parallel. SSE events drive:
      // - ThinkingDelta/TextDelta → real-time UI typewriter effect (PartDelta Bus events)
      // - LoopDone/LoopError → early exit (skip waiting for next poll cycle)
      //
      // Note: Pending tool detection and delegated execution remain poll-driven
      // (the poll loop below checks for pending parts every 100-500ms). SSE does
      // not currently handle tool_pending events for immediate execution.
      //
      // ThinkingDelta/TextDelta now carry real messageID/partID (Rust pre-generates
      // IDs before the LLM stream). On the first delta for a (messageID, partID)
      // pair we create a placeholder PartUpdated event so the frontend store has
      // a part to accumulate deltas into. Subsequent deltas use PartDelta with
      // the same IDs to drive real-time typewriter effect.
      //
      // The SSE subscription is fire-and-forget — if it fails or disconnects,
      // the polling loop below continues as fallback. DB is always source of truth.
      const clients = createSmartLayerClients()
      let sseDone = false
      // Captured error message from a Rust `loop_error` SSE event. Consumed by
      // the poll loop to synthesize an assistant error message when the run
      // ends without producing one (e.g. an immediate LLM HTTP 403 on step 0,
      // where Rust only emits `LoopError` and breaks — no assistant row).
      let runError: string | null = null

      // Track which (messageID, partID) pairs already have placeholder parts
      // in the frontend store. Rust emits many deltas for the same part — we
      // only need to create the placeholder once (on the first delta).
      const placeholderCreated = new Set<string>()

      // Track which tool part IDs have been published to the frontend store.
      // Rust-executed tools write directly to the DB but don't trigger
      // PartUpdated SSE events. This set prevents re-publishing the same part.
      const toolPartsPublished = new Set<string>()

      function ensurePlaceholder(sessionID: SessionID, messageID: string, partID: string, type: "text" | "reasoning") {
        const key = `${messageID}:${partID}`
        if (placeholderCreated.has(key)) return
        placeholderCreated.add(key)

        // Fire-and-forget PartUpdated to create a placeholder in the frontend
        // store. text="" — deltas will accumulate the real content.
        // No time.end — this signals "streaming in progress" (the race-condition
        // guard in event-reducer checks part.time?.end before applying deltas).
        const placeholderPart = {
          id: partID,
          sessionID,
          messageID,
          type,
          text: "",
          time: { start: Date.now() },
        } as any

        void Bus.publish(MessageV2.Event.PartUpdated as any, {
          sessionID,
          part: placeholderPart,
          time: Date.now(),
        })
      }

      // ── Placeholder assistant message for streaming UI ──
      // ensurePlaceholder above only creates a placeholder *part* in the
      // frontend store. Without a corresponding assistant *message* in
      // store.message[sessionID], session-turn.tsx's assistantMessages()
      // collects nothing → AssistantParts never renders → the user sees no
      // output until the runLoop finishes and the real message.updated
      // arrives (one-shot instead of typewriter).
      //
      // To fix this, on the first SSE delta we also publish a placeholder
      // message.updated (assistant, completed=undefined) using the same
      // fire-and-forget Bus.publish pattern as ensurePlaceholder. The real
      // message.updated (with completed/tokens/finish) arrives after the
      // stream and reconciles over the placeholder by id (both use Rust's
      // pre_assistant_msg_id). store.part is untouched by message.updated,
      // so accumulated delta content is preserved.
      //
      // Field source: pre-fetch the last user message + ctx + model here
      // (generator context, so we can yield*). The async SSE loop below
      // cannot yield Effects, so it calls the plain function
      // ensureAssistantPlaceholder(messageID) which closes over these.
      const assistantPlaceholderCreated = new Set<string>()
      let assistantInfoBuilder: ((messageID: string) => MessageV2.Assistant | undefined) | undefined
// @effect-diagnostics-next-line tryCatchInEffectGen:off
      try {
        const lastUserMsg = yield* sessions.findMessage(
          sessionID,
          (m) => m.info.role === "user" && !!m.info.model,
        )
        const agentName =
          Option.isSome(lastUserMsg) && lastUserMsg.value.info.role === "user"
            ? lastUserMsg.value.info.agent
            : (yield* agents.defaultAgent())
        const agent = yield* agents.get(agentName)
        const modelRef =
          Option.isSome(lastUserMsg) && lastUserMsg.value.info.role === "user"
            ? lastUserMsg.value.info.model
            : undefined
        let model: Provider.Model
        if (modelRef) {
          model = yield* getModel(modelRef.providerID, modelRef.modelID, sessionID)
        } else if (agent?.model) {
          model = yield* getModel(agent.model.providerID, agent.model.modelID, sessionID)
        } else {
          const fallback = yield* lastModel(sessionID)
          model = yield* getModel(fallback.providerID, fallback.modelID, sessionID)
        }
        const ctx = yield* InstanceState.context
        const parentID =
          Option.isSome(lastUserMsg) && lastUserMsg.value.info.role === "user"
            ? lastUserMsg.value.info.id
            : undefined
        assistantInfoBuilder = (messageID: string): MessageV2.Assistant | undefined => {
          if (!parentID) return undefined
          return {
            id: messageID as MessageID,
            sessionID,
            parentID,
            mode: agentName,
            agent: agentName,

            path: { cwd: ctx.directory, root: ctx.worktree },
            // No time.completed — signals "streaming in progress". The real
            // message.updated (with completed) reconciles over this by id.
            time: { created: Date.now() },
            role: "assistant",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.id,
            providerID: model.providerID,
          } as MessageV2.Assistant
        }
      } catch (e) {
        // Field pre-fetch failed (e.g. no user message yet, model lookup
        // failed). Skip placeholder assistant — degrades to original
        // one-shot behaviour, no worse than the status quo.
        process.stderr.write(`[TRACE-sse] assistant placeholder builder skipped: ${e instanceof Error ? e.message : String(e)}\n`)
      }

      function ensureAssistantPlaceholder(messageID: string) {
        if (!assistantInfoBuilder) return
        if (assistantPlaceholderCreated.has(messageID)) return
        assistantPlaceholderCreated.add(messageID)

        const info = assistantInfoBuilder(messageID)
        if (!info) return

        // Fire-and-forget message.updated to create a placeholder assistant
        // in the frontend store.message. Same `as any` pattern as
        // ensurePlaceholder: Updated is a SyncEvent, but we publish it as a
        // BusEvent so it reaches the frontend via the global SSE bridge
        // (payload.type is "message.updated", not "sync" — not skipped by
        // global-sdk.tsx's sync filter).
        void Bus.publish(MessageV2.Event.Updated as any, {
          sessionID,
          info,
        })
      }

      if (clients?.agent) {
        const sseStream: Effect.Effect<void> = Effect.promise(async () => {
          try {
            process.stderr.write(`[TRACE-sse] subscribing to Rust runLoop events for sessionID=${sessionID}\n`)
            for await (const { event, data } of clients.agent.subscribeRunLoopEvents(sessionID)) {
              if (sseDone) break
              if (event === "thinking") {
                process.stderr.write(`[TRACE-partdelta] thinking received data=${data.slice(0, 100)}\n`)
                const parsed = JSON.parse(data) as { messageID: string; partID: string; content: string }
                // Create placeholder part on first delta so frontend reducer can find it.
                ensurePlaceholder(sessionID, parsed.messageID, parsed.partID, "reasoning")
                // Also create a placeholder assistant message so AssistantParts
                // renders immediately (typewriter effect) instead of waiting
                // for the post-stream message.updated.
                ensureAssistantPlaceholder(parsed.messageID)
                void Bus.publish(MessageV2.Event.PartDelta, {
                  sessionID,
                  messageID: parsed.messageID as MessageID,
                  partID: parsed.partID as PartID,
                  field: "text",
                  delta: parsed.content,
                })
              } else if (event === "delta") {
                process.stderr.write(`[TRACE-partdelta] delta received data=${data.slice(0, 100)}\n`)
                const parsed = JSON.parse(data) as { messageID: string; partID: string; content: string }
                // Same placeholder logic as thinking — must exist before delta can accumulate.
                ensurePlaceholder(sessionID, parsed.messageID, parsed.partID, "text")
                // Same placeholder assistant message as thinking — first delta
                // for a new messageID creates the message the UI renders into.
                ensureAssistantPlaceholder(parsed.messageID)
                void Bus.publish(MessageV2.Event.PartDelta, {
                  sessionID,
                  messageID: parsed.messageID as MessageID,
                  partID: parsed.partID as PartID,
                  field: "text",
                  delta: parsed.content,
                })
            } else if (event === "loop_done" || event === "loop_error") {
              process.stderr.write(`[TRACE-sse] received ${event}, setting sseDone=true\n`)
              sseDone = true
              // Capture the error text from a `loop_error` event so the poll
              // loop can synthesize a visible assistant error message when the
              // run produced none. Rust emits `LoopError { session_id, message }`
              // (agent.rs); the message is the human-readable failure (e.g.
              // "LLM API returned HTTP 403: Forbidden").
              if (event === "loop_error") {
                try {
                  const parsed = JSON.parse(data) as { message?: string }
                  if (parsed.message) runError = parsed.message
                } catch {
                  // Parse failure is non-fatal — runError stays null and the
                  // poll loop falls back to the last known assistant message.
                }
              }
              // Eagerly publish session status idle via Bus so the frontend
              // receives it immediately via SSE. This complements the
              // Effect.ensuring(status.set(idle)) guarantee — if that cleanup
              // runs first, this is a no-op (idle is already set); if the
              // Effect fiber is killed (e.g. sidecar restart), this ensures
              // the frontend still gets the idle event.
              void Bus.publish(SessionStatus.Event.Status as any, {
                sessionID,
                status: { type: "idle" as const },
              })
              return
            } else if (event === "subagent_started") {
                // Rust execute_task created a child session. Publish session.updated
                // so the frontend sidebar shows the child session immediately.
                //
                // We do NOT publish session.status "busy" here, because
                // execute_task is currently synchronous — Rust emits
                // SubagentStarted and SubagentDone back-to-back. The async
                // IIFE below (DB read + Bus.publish) would resolve AFTER
                // the synchronous SubagentDone handler publishes "idle",
                // leaving the session stuck in "busy". Only publishing
                // "idle" from SubagentDone avoids this race condition.
                // (When async sub-agent execution is added in the future,
                //  SubagentDone will arrive much later, and a "busy" push
                //  here will be safe to re-enable.)
                const parsed = JSON.parse(data) as {
                  parentSessionId: string
                  childSessionId: string
                  subagentType: string
                  description: string
                }
                process.stderr.write(
                  `[TRACE-sse] subagent_started: child=${parsed.childSessionId} type=${parsed.subagentType}\n`,
                )
                // Fetch child session Info from shared DB and publish to frontend.
                // Bus.publish is async and self-executing (fire-and-forget with void).
                void (async () => {
                  try {
                    const rt = await getAppRuntime()
                    if (!rt) return
                    const info = await rt.runPromise(
                      Session.Service.use((svc) => svc.get(parsed.childSessionId as SessionID)),
                    )
                    void Bus.publish(Session.Event.Updated as any, {
                      sessionID: parsed.childSessionId,
                      info,
                    })
                  } catch (err) {
                    process.stderr.write(
                      `[TRACE-sse] subagent_started: failed to publish session for child=${parsed.childSessionId}: ${err}\n`,
                    )
                  }
                })()
              } else if (event === "subagent_done") {
                // Sub-agent finished. Publish idle status so the spinner stops.
                const parsed = JSON.parse(data) as {
                  parentSessionId: string
                  childSessionId: string
                }
                process.stderr.write(`[TRACE-sse] subagent_done: child=${parsed.childSessionId}\n`)
                void Bus.publish(SessionStatus.Event.Status as any, {
                  sessionID: parsed.childSessionId,
                  status: { type: "idle" as const },
                })
              } else if (event === "subagent_error") {
                // Sub-agent errored. Publish idle status so the spinner stops.
                const parsed = JSON.parse(data) as {
                  parentSessionId: string
                  childSessionId: string
                  error: string
                }
                process.stderr.write(`[TRACE-sse] subagent_error: child=${parsed.childSessionId} error=${parsed.error}\n`)
                void Bus.publish(SessionStatus.Event.Status as any, {
                  sessionID: parsed.childSessionId,
                  status: { type: "idle" as const },
                })
              } else if (event === "lagged") {
                // SSE buffer overflow — some delta events were lost.
                // Not critical: DB is source of truth, polling fallback covers correctness.
                // Log for diagnostics; real-time typewriter effect may stutter.
                const parsed = JSON.parse(data) as { missed: number }
                void elog.warn("sse lagged, falling back to polling", { sessionID, missed: parsed.missed })
              } else if (event === "loop_started") {
                process.stderr.write(`[TRACE-sse] received loop_started — Rust runLoop is running\n`)
              } else if (event === "llm_call_done") {
                process.stderr.write(`[TRACE-sse] received llm_call_done\n`)
              } else if (event === "tool_pending") {
                process.stderr.write(`[TRACE-sse] received tool_pending\n`)
                // Publish placeholder tool part so frontend can show it immediately.
                // Full data (input/output) will be published when the poll loop
                // reads the completed part from DB.
                const tp = JSON.parse(data) as { session_id: string; call_id: string; tool_name: string; part_id: string; message_id: string }
                const key = `${tp.message_id}:${tp.part_id}`
                if (!toolPartsPublished.has(key)) {
                  toolPartsPublished.add(key)
                  void Bus.publish(MessageV2.Event.PartUpdated as any, {
                    sessionID: tp.session_id,
                    part: {
                      id: tp.part_id,
                      sessionID: tp.session_id,
                      messageID: tp.message_id,
                      type: "tool",
                      tool: tp.tool_name,
                      callID: tp.call_id,
                      state: {
                        status: "pending",
                        time: { start: Date.now() },
                      },
                    },
                    time: Date.now(),
                  })
                }
              } else if (event === "tool_running") {
                process.stderr.write(`[TRACE-sse] received tool_running\n`)
                // Clear the published flag so the poll loop re-publishes
                // the running part with updated state.
                const tr = JSON.parse(data) as { session_id: string; call_id: string; part_id: string }
                for (const key of toolPartsPublished) {
                  if (key.endsWith(`:${tr.part_id}`)) {
                    toolPartsPublished.delete(key)
                    break
                  }
                }
              } else if (event === "tool_completed") {
                process.stderr.write(`[TRACE-sse] received tool_completed\n`)
                // Clear the published flag so the poll loop re-publishes
                // the completed part with full data (input, output, etc.).
                const tc = JSON.parse(data) as { session_id: string; call_id: string; part_id: string }
                // We don't have message_id here, so iterate and match by part_id
                for (const key of toolPartsPublished) {
                  if (key.endsWith(`:${tc.part_id}`)) {
                    toolPartsPublished.delete(key)
                    break
                  }
                }
              } else if (event === "tool_error") {
                process.stderr.write(`[TRACE-sse] received tool_error\n`)
                // Same as tool_completed — clear flag so poll loop re-publishes with error state
                const te = JSON.parse(data) as { session_id: string; call_id: string; part_id: string; error: string }
                for (const key of toolPartsPublished) {
                  if (key.endsWith(`:${te.part_id}`)) {
                    toolPartsPublished.delete(key)
                    break
                  }
                }
              }
            }
          } catch (sseErr) {
            // SSE failed — silently fall back to polling
            process.stderr.write(
              `[TRACE-sse] SSE connection failed: ${sseErr instanceof Error ? sseErr.message : String(sseErr)}\n`,
            )
          }
        })
        yield* sseStream.pipe(Effect.ignore, Effect.forkIn(scope))
      }

      const pollT0 = Date.now()
      // ── Watchdog state (see constants above) ──
      const fingerprintOf = (msgs: MessageV2.WithParts[]): string =>
        `${msgs.length}:${msgs.at(-1)?.info.id ?? ""}:${msgs.reduce((n, m) => n + m.parts.length, 0)}`
      let lastFingerprint = fingerprintOf(snapshotMsgs)
      let lastProgressAt = pollT0
      let lastProbeAt = 0
      let goneSince: number | null = null
      for (let attempt = 0; ; attempt++) {
        // Explicit abort signal (SessionPrompt.cancel) — terminate promptly.
        // The run fiber is not registered in SessionRunState, so Fiber.interrupt
        // cannot reach this loop; this flag is the reliable stop signal so that
        // clicking STOP actually stops polling instead of running to the budget.
        if (abortedSessions.has(sessionID)) {
          process.stderr.write(`[TRACE-poll] abort signaled for ${sessionID}, returning early\n`)
          yield* elog.debug("timing: poll aborted by user", { sessionID, attempt, elapsedMs: Date.now() - pollT0 })
          abortedSessions.delete(sessionID)
          return yield* lastAssistant(sessionID)
        }

        // ── Liveness probe: has the Rust loop task exited? ──
        // GET /agent/metrics flips to running:false when the loop task is gone
        // (its cleanup removes the metrics entry). Require the gone signal to
        // persist LIVENESS_GRACE_MS so the LoopDone→cleanup race can't clip a
        // healthy run: a normal completion sets sseDone / writes finish=stop
        // long before this window closes.
        const nowMs = Date.now()
        if (nowMs - lastProbeAt >= LIVENESS_PROBE_INTERVAL_MS) {
          lastProbeAt = nowMs
          const active = clients?.agent
            ? yield* Effect.promise(() => clients.agent!.isRunLoopActive(sessionID))
            : true
          if (active) {
            goneSince = null
          } else if (goneSince === null) {
            goneSince = nowMs
          } else if (nowMs - goneSince >= LIVENESS_GRACE_MS) {
            process.stderr.write(
              `[TRACE-poll] ⚠ liveness probe: runLoop gone without terminal event for ${sessionID}, resolving\n`,
            )
            yield* elog.warn("rustRunLoopPoll: runLoop exited without terminal event", { sessionID, attempt })
            const finalMsgs = yield* MessageV2.filterCompactedEffect(sessionID)
            const finalAssistant = finalMsgs.findLast((m) => m.info.role === "assistant")
            if (finalAssistant && finalAssistant.info.id !== prevLastAssistantId) return finalAssistant
            if (runError) return yield* createRunLoopErrorMessage(sessionID, runError)
            return yield* lastAssistant(sessionID)
          }
        }

        // ── No-progress watchdog: DB layout unchanged too long ──
        // Any new message/part row counts as progress. A stuck loop (hung LLM
        // stream, dead provider connection) produces nothing for the threshold
        // window; cancel it and surface a visible error instead of polling
        // forever.
        if (nowMs - lastProgressAt >= STUCK_THRESHOLD_MS) {
          process.stderr.write(
            `[TRACE-poll] ⚠ no DB progress for ${STUCK_THRESHOLD_MS}ms, cancelling stuck runLoop ${sessionID}\n`,
          )
          yield* elog.warn("rustRunLoopPoll: no-progress watchdog fired, cancelling runLoop", {
            sessionID,
            attempt,
          })
          if (clients?.agent) {
            yield* Effect.promise(() => clients.agent!.cancelRunLoop(sessionID).catch(() => undefined))
          }
          const stuckMsgs = yield* MessageV2.filterCompactedEffect(sessionID)
          const stuckAssistant = stuckMsgs.findLast((m) => m.info.role === "assistant")
          if (stuckAssistant && stuckAssistant.info.id !== prevLastAssistantId) return stuckAssistant
          return yield* createRunLoopErrorMessage(
            sessionID,
            i18n({
              en: `The task produced no new message or tool output for ${Math.round(STUCK_THRESHOLD_MS / 60_000)} minutes and was stopped automatically (the model may have stopped responding). Send "continue" to restart it.`,
              zh: `任务已超过 ${Math.round(STUCK_THRESHOLD_MS / 60_000)} 分钟没有任何新消息或工具产出，已自动停止（可能是模型无响应）。可发送「继续」重新启动。`,
            }),
          )
        }
        // If SSE signaled completion (loop_done/loop_error), return immediately
        // without waiting for the next poll — but only if a NEW assistant message
        // exists (not the previous round's stale one). Rust emits loop_done only
        // AFTER the runLoop fully ends, so the latest assistant message is final.
        //
        // NOTE: we intentionally do NOT require `finish === "stop"`. When the loop
        // ends early (stall fuse / max_steps / context_overflow / a tool-call round),
        // the final assistant message can legitimately carry `finish: "tool-calls"`.
        // Requiring "stop" here made the poll spin until its 2400-attempt budget
        // (~17 min) before returning — the "auto stop / hangs forever" symptom.
        if (sseDone) {
          const msgs = yield* MessageV2.filterCompactedEffect(sessionID)
          const lastAssistantMsg = msgs.findLast((m) => m.info.role === "assistant")
          const lastFinish = lastAssistantMsg
            ? (lastAssistantMsg.info as MessageV2.Assistant).finish
            : "none"
          if (attempt < 3 || attempt % 30 === 0) {
            process.stderr.write(
              `[TRACE-poll] sseDone exit-check attempt=${attempt}, lastAssistant=${lastAssistantMsg?.info.id ?? "none"}, prevLast=${prevLastAssistantId ?? "none"}, finish=${lastFinish}\n`,
            )
          }
          // Normal completion: a NEW assistant message was produced by the run.
          if (lastAssistantMsg && lastAssistantMsg.info.id !== prevLastAssistantId) {
            process.stderr.write(
              `[TRACE-poll] ✓ loop_done + new assistant → exiting early (attempt=${attempt}, finish=${lastFinish})\n`,
            )
            return lastAssistantMsg
          }
          // Run ended (loop_done/loop_error) but produced NO new assistant
          // message. This happens on immediate failures — e.g. an LLM HTTP 403
          // on step 0 — where Rust emits `loop_error` WITHOUT writing an
          // assistant row to the DB. The old code kept spinning here until the
          // 2400-attempt budget (~17 min), which (a) hid the error from the
          // user and (b) wedged the project task slot (max_concurrent=1),
          // making every subsequent send fail with a silent 409. When an error
          // was captured, synthesize a visible assistant error message so the
          // rest of the pipeline (post-loop side effects, UI error card) and
          // the frontend get a valid result.
          if (runError) {
            process.stderr.write(
              `[TRACE-poll] sseDone + no new assistant + runError → synthesizing error message (attempt=${attempt})\n`,
            )
            return yield* createRunLoopErrorMessage(sessionID, runError)
          }
          // Defensive: sseDone without a new message AND without a captured
          // error. Should not happen, but avoid an infinite spin — fall back
          // to the last known assistant message (same fallback as budget-exhausted).
          process.stderr.write(
            `[TRACE-poll] sseDone + no new assistant + no error → fallback (attempt=${attempt})\n`,
          )
          return yield* lastAssistant(sessionID)
        }

        const msgs = yield* MessageV2.filterCompactedEffect(sessionID)

        // Fingerprint the DB layout for the no-progress watchdog. Any new
        // message or part row (Rust writes tool parts continuously while it
        // works) counts as progress and pushes the watchdog deadline out.
        const fp = fingerprintOf(msgs)
        if (fp !== lastFingerprint) {
          lastFingerprint = fp
          lastProgressAt = Date.now()
        }

        // Publish Rust-executed tool parts to frontend store.
        // Rust writes tool parts (Pending→Running→Completed) directly to DB
        // but the SSE tool_pending/tool_running/tool_completed events are
        // fire-and-forget and don't carry full part data. Without this,
        // tool parts only appear after a page refresh.
        for (const msg of msgs) {
          if (msg.info.role !== "assistant") continue
          for (const part of msg.parts) {
            if (part.type !== "tool") continue
            const key = `${msg.info.id}:${part.id}`
            if (toolPartsPublished.has(key)) continue
            toolPartsPublished.add(key)
            void Bus.publish(MessageV2.Event.PartUpdated as any, {
              sessionID,
              part: { ...part, sessionID },
              time: Date.now(),
            })
          }
        }

        // Log every 30th poll attempt (or first 3) to avoid spam
        if (attempt < 3 || attempt % 30 === 0) {
          const lastAssistant = msgs.findLast((m) => m.info.role === "assistant")
          const pendingTools = msgs
            .filter((m) => m.info.role === "assistant")
            .flatMap((m) => m.parts)
            .filter((p) => p.type === "tool" && p.state.status === "pending")
          process.stderr.write(
            `[TRACE-poll] attempt=${attempt}, msgs=${msgs.length}, lastAssistant=${lastAssistant ? `id=${lastAssistant.info.id},finish=${(lastAssistant.info as MessageV2.Assistant).finish}` : "none"}, pendingTools=${pendingTools.length}, sseDone=${sseDone}\n`,
          )
        }

        // 1. Detect and execute pending tool parts delegated from Rust.
        // Rust inserts tool parts as Pending. For tools it delegates to TS,
        // it leaves the part in Pending state (only Rust-executed tools
        // transition to Running). We detect Pending parts and execute them.
        // Walk messages in reverse to find the most recent delegated tools first.
        const pendingParts: Extract<MessageV2.Part, { type: "tool" }>[] = []
        for (let i = msgs.length - 1; i >= 0; i--) {
          const msg = msgs[i]!
          if (msg.info.role !== "assistant") continue
          for (const part of msg.parts) {
            if (part.type === "tool" && part.state.status === "pending") {
              if (handledCallIDs.has(part.callID)) continue
              handledCallIDs.add(part.callID)
              pendingParts.push(part)
            }
          }
        }
        if (pendingParts.length > 0) {
          yield* Effect.forEach(
            pendingParts,
            (part) => {
              process.stderr.write(
                `[TRACE-poll] executing delegated tool: ${part.tool} (state=${part.state.status}), callID=${part.callID}\n`,
              )
              // DEBUG timing (debug-level only; no effect on normal logic).
              return elog
                .debug("timing: delegated tool executed", {
                  sessionID,
                  tool: part.tool,
                  attempt,
                  elapsedMs: Date.now() - pollT0,
                })
                .pipe(
                  Effect.andThen(
                    executePendingToolPart(part, sessionID).pipe(
                      Effect.catchCause((cause) =>
                        elog.warn("delegated tool execution failed", {
                          sessionID,
                          tool: part.tool,
                          callID: part.callID,
                          error: String(Cause.squash(cause)),
                        }),
                      ),
                    ),
                  ),
                )
            },
            { concurrency: "unbounded" },
          )
        }

        // 2. Check if runLoop completed — a NEW assistant message (different from
        //    the one that existed before we started polling) has finish=stop.
        //    finish=tool-calls means the Rust runLoop is NOT done — it delegated
        //    a tool to TS and is waiting for the result. Returning here would
        //    leave the Rust runLoop stuck waiting for a tool result that never
        //    comes, and the next prompt's runLoop would block on the session
        //    lock held by this stuck runLoop.
        //    The pending tool detection above (step 1) should execute the tool;
        //    after execution, the Rust runLoop continues and eventually produces
        //    a final assistant message with finish=stop (or another tool-calls).
        const lastAssistantMsg = msgs.findLast((m) => m.info.role === "assistant")
        if (
          lastAssistantMsg &&
          lastAssistantMsg.info.id !== prevLastAssistantId &&
          (lastAssistantMsg.info as MessageV2.Assistant).finish === "stop"
        ) {
          process.stderr.write(
            `[TRACE-poll] ⑧ runLoop completed! new msg id=${lastAssistantMsg.info.id}, finish=${(lastAssistantMsg.info as MessageV2.Assistant).finish}, returning\n`,
          )
          // DEBUG timing (debug-level only; no effect on normal logic).
          yield* elog.debug("timing: runLoop completed", { sessionID, attempt, elapsedMs: Date.now() - pollT0 })
          return lastAssistantMsg
        }

        // 3. Wait before next poll (with backoff)
        const delay = attempt < FAST_PHASE_ATTEMPTS ? FAST_POLL_MS : SLOW_POLL_MS
        yield* Effect.sleep(`${delay} millis`)
      }
    })

    // Tool schema transform cache (perf optimization).
    // `ProviderTransform.schema(model, schema)` is a PURE function of
    // (model, tool schema); the same (model, toolId) always yields
    // the same output. Caching it across delegateToRustRunLoop
    // calls avoids re-deriving every tool's schema on every message
    // send. The cache key includes provider+model+toolId, so a
    // different model or a different tool always re-computes. MCP tools
    // are still fetched live each call (see the loop below) and only
    // their transform result is cached — new MCP tools simply miss
    // the cache once, which is correct.
    const toolSchemaCache = new Map<string, unknown>()

    // Overflow retry counter — prevents infinite recursion when compaction
    // repeatedly fails to reduce context size (mirrors llm.rs MAX_ATTEMPTS = 3).
    let overflowRetries = 0
    const MAX_OVERFLOW_RETRIES = 3

    const delegateToRustRunLoop: (
      sessionID: SessionID,
      autoAccept?: boolean,
    ) => Effect.Effect<MessageV2.WithParts, unknown, unknown> = Effect.fn(
      "SessionPrompt.delegateToRustRunLoop",
    )(function* (sessionID: SessionID, autoAccept?: boolean) {
        process.stderr.write(`[TRACE-delegate] ④ delegateToRustRunLoop start, sessionID=${sessionID}\n`)
        yield* elog.info("delegateToRustRunLoop: start", { sessionID })
        // A previous run may have been aborted; clear the flag so this new run
        // is not immediately terminated by a stale abort signal.
        abortedSessions.delete(sessionID)
        const delegateT0 = Date.now()
        // Delegate to Rust runLoop via smart-layer HTTP.
        // Rust spawns the loop in the background and returns { status: "started" }.
        // TS then polls DB until the assistant message has a finish field.
        const clients = createSmartLayerClients()
        if (!clients) {
          process.stderr.write(`[TRACE-delegate] ✗ no smart-layer clients! DUO_SMART_LAYER_URL not set?\n`)
          yield* elog.error("delegateToRustRunLoop: no smart-layer clients", { sessionID })
          return yield* Effect.fail(new NamedError.Unknown({ message: "Rust runLoop requires smart-layer connection" }))
        }
        process.stderr.write(`[TRACE-delegate] ⑤ smart-layer clients ok, gathering context\n`)

        // Gather context for Rust runLoop: tools, permission_rules, model, agent, project_path
        const session = yield* sessions
          .get(sessionID)
          .pipe(
            Effect.tapError((e) =>
              Effect.sync(() => process.stderr.write(`[TRACE-delegate] ✗ sessions.get failed: ${String(e)}\n`)),
            ),
          )
        process.stderr.write(`[TRACE-delegate] ⑤a session ok\n`)
        const lastUserMsg = yield* sessions
          .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
          .pipe(
            Effect.tapError((e) =>
              Effect.sync(() => process.stderr.write(`[TRACE-delegate] ✗ sessions.findMessage failed: ${String(e)}\n`)),
            ),
          )
        process.stderr.write(`[TRACE-delegate] ⑤b lastUserMsg ok (isSome=${Option.isSome(lastUserMsg)})\n`)
        const agentName =
          Option.isSome(lastUserMsg) && lastUserMsg.value.info.role === "user"
            ? lastUserMsg.value.info.agent
            : yield* agents.defaultAgent()
        // Locale follows the program's UI language, which the frontend records on
        // each user message (UserMessage.locale). When absent, environment() falls
        // back to "respond in the user's message language" — same as before.
        const locale =
          Option.isSome(lastUserMsg) && lastUserMsg.value.info.role === "user"
            ? lastUserMsg.value.info.locale
            : undefined
        process.stderr.write(`[TRACE-delegate] ⑤c agentName=${agentName}\n`)
        const agent = yield* agents
          .get(agentName)
          .pipe(
            Effect.tapError((e) =>
              Effect.sync(() => process.stderr.write(`[TRACE-delegate] ✗ agents.get failed: ${String(e)}\n`)),
            ),
          )
        process.stderr.write(`[TRACE-delegate] ⑤d agent ok\n`)
        const modelRef =
          Option.isSome(lastUserMsg) && lastUserMsg.value.info.role === "user"
            ? lastUserMsg.value.info.model
            : undefined
        let model: Provider.Model
        if (modelRef) {
          model = yield* getModel(modelRef.providerID, modelRef.modelID, sessionID).pipe(
            Effect.tapError((e) =>
              Effect.sync(() => process.stderr.write(`[TRACE-delegate] ✗ getModel(modelRef) failed: ${String(e)}\n`)),
            ),
          )
        } else if (agent?.model) {
          model = yield* getModel(agent.model.providerID, agent.model.modelID, sessionID).pipe(
            Effect.tapError((e) =>
              Effect.sync(() =>
                process.stderr.write(`[TRACE-delegate] ✗ getModel(agent.model) failed: ${String(e)}\n`),
              ),
            ),
          )
        } else {
          const fallback = yield* lastModel(sessionID).pipe(
            Effect.tapError((e) =>
              Effect.sync(() => process.stderr.write(`[TRACE-delegate] ✗ lastModel failed: ${String(e)}\n`)),
            ),
          )
          model = yield* getModel(fallback.providerID, fallback.modelID, sessionID).pipe(
            Effect.tapError((e) =>
              Effect.sync(() => process.stderr.write(`[TRACE-delegate] ✗ getModel(fallback) failed: ${String(e)}\n`)),
            ),
          )
        }

        // If a previous run discovered a working output limit for this model
        // (after max_tokens errors), use it instead of the configured value so
        // we don't repeat the degradation retry every turn. See the retry
        // wrapper below (runAgentTurn → delegateToRustRunLoopWithOutputRetry).
        const discoveredOutput = getDiscoveredOutputLimit(model)
        if (discoveredOutput !== undefined) {
          model.limit = { ...model.limit, output: discoveredOutput }
        }

        process.stderr.write(`[TRACE-delegate] ⑤e model ok: providerID=${model.providerID}, modelID=${model.api.id}\n`)

        // Build system prompt from SystemPrompt.provider + environment.
        // This is passed to the Rust runLoop via postRunLoop's system_prompt
        // field. Without it, the LLM in the Rust path would not receive
        // "You are DuoDuoCode..." or tool-usage instructions.
        // A-class enhancement: inject local coding standards (AGENTS.md family) so the
        // Rust run-loop path honours the team's rules. Remote URLs stay (main path only).
        const codingStandards = yield* sys.projectGuidance({ excludeRemoteUrls: false, includeSharedTypes: true })
        const systemPromptParts: string[] = [
          ...(agent.prompt ? [agent.prompt] : systemPromptProvider(model)),
          ...sys.environment(model, { locale }),
          ...(codingStandards ? [codingStandards] : []),
          // Daily-changing line goes LAST so the stable prefix above stays
          // byte-identical across days (implicit provider prefix caching on
          // the Rust path — agent.rs merges this string into the first
          // system message as-is, no cache_control involved).
          SystemPrompt.dateDirective(),
        ]
        const systemPrompt = systemPromptParts.filter(Boolean).join("\n")

        // Build tool definitions from registry + MCP
        const toolDefs: Array<{
          type: "function"
          function: { name: string; description: string; parameters: unknown }
        }> = []

        if (agent) {
          const registryTools = yield* registry
            .tools({
              providerID: model.providerID,
              modelID: ModelID.make(model.api.id),
              agent,
            })
            .pipe(
              Effect.tapError((e) =>
                Effect.sync(() => process.stderr.write(`[TRACE-delegate] ✗ registry.tools failed: ${String(e)}\n`)),
              ),
            )
          process.stderr.write(`[TRACE-delegate] ⑤f registry.tools ok (${registryTools.length} tools)\n`)

          // Filter tools by permission — mirrors the TS path's resolveTools
          // (llm.ts:513-519). Without this, the LLM may see tools it cannot
          // execute, wasting a turn on a permission-denied error.
          const mergedPermissionRules = Permission.merge(agent.permission ?? [], session.permission ?? [])
          const disabledToolSet = Permission.disabled(
            registryTools.map((t) => t.id),
            mergedPermissionRules,
          )
          const visibleTools = registryTools.filter((t) => !disabledToolSet.has(t.id))
          process.stderr.write(`[TRACE-delegate] ⑤f1 permission filter: ${registryTools.length} → ${visibleTools.length} tools (${disabledToolSet.size} disabled)\n`)

          for (const t of visibleTools) {
            const cacheKey = `${model.providerID}:${model.api.id}:${t.id}`
            let schema = toolSchemaCache.get(cacheKey)
            if (schema === undefined) {
              schema = ProviderTransform.schema(model, z.toJSONSchema(t.parameters))
              toolSchemaCache.set(cacheKey, schema)
            }
            toolDefs.push({
              type: "function",
              function: {
                name: t.id,
                description: t.description,
                parameters: schema,
              },
            })
          }

          const mcpToolMap = yield* mcp
            .tools()
            .pipe(
              Effect.tapError((e) =>
                Effect.sync(() => process.stderr.write(`[TRACE-delegate] ✗ mcp.tools failed: ${String(e)}\n`)),
              ),
            )
          process.stderr.write(`[TRACE-delegate] ⑤g mcp.tools ok (${Object.keys(mcpToolMap).length} tools)\n`)
          for (const [key, item] of Object.entries(mcpToolMap)) {
            if (!item.execute) continue
            // Apply same permission filter to MCP tools
            if (disabledToolSet.has(key)) continue
            const mcpSchema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
            const mcpCacheKey = `${model.providerID}:${model.api.id}:${key}`
            let transformed = toolSchemaCache.get(mcpCacheKey)
            if (transformed === undefined) {
              transformed = ProviderTransform.schema(model, mcpSchema)
              toolSchemaCache.set(mcpCacheKey, transformed)
            }
            toolDefs.push({
              type: "function",
              function: {
                name: key,
                description: typeof item.description === "string" ? item.description : "",
                parameters: transformed,
              },
            })
          }
        }

        // Build permission rules from session + agent
        const permissionRules = Permission.merge(agent?.permission ?? [], session.permission ?? []).map((r) => ({
          permission: r.permission,
          action: r.action,
          pattern: r.pattern,
        }))

        // Get project path
        const ctx = yield* InstanceState.context.pipe(
          Effect.tapError((e) =>
            Effect.sync(() => process.stderr.write(`[TRACE-delegate] ✗ InstanceState.context failed: ${String(e)}\n`)),
          ),
        )
        process.stderr.write(`[TRACE-delegate] ⑤h ctx ok: dir=${ctx.directory}, worktree=${ctx.worktree}\n`)

        // Extract output_format from the last user message if it has a json_schema format
        const outputFormat =
          Option.isSome(lastUserMsg) &&
          lastUserMsg.value.info.role === "user" &&
          lastUserMsg.value.info.format?.type === "json_schema"
            ? lastUserMsg.value.info.format
            : undefined

        // Resolve the snapshot gitdir with the SAME formula the Snapshot.Service
        // uses, so Rust-written tree hashes are valid when TS later consumes them
        // in the same repo (revert/restore/diff/diffFull). Guarded by vcs==="git"
        // to mirror Snapshot.Service's enabled() — non-git projects pass undefined
        // (Rust skips snapshot).
        // NOTE: keyed on ctx.directory (not ctx.worktree) so the snapshot worktree matches
        // the Rust run_loop's project_path — both scope to the opened sub-project, keeping
        // tree hashes compatible and avoiding a full-monorepo `git add --all`.
        const snapshotGitdir =
          ctx.project.vcs === "git" ? snapshotGitDir(ctx.project.id, ctx.directory) : undefined

        // Set session status to busy for the duration of the Rust runLoop.
        // This mirrors the old TS processor.ts "start" event handler (L240-242)
        // which set status to busy when the LLM stream started.
        yield* status
          .set(sessionID, { type: "busy" })
          .pipe(
            Effect.tapError((e) =>
              Effect.sync(() => process.stderr.write(`[TRACE-delegate] ✗ status.set(busy) failed: ${String(e)}\n`)),
            ),
          )
        process.stderr.write(`[TRACE-delegate] ⑤i status.set(busy) ok\n`)

        // Pass LLM config inline so the smart-layer can use it even if no
        // prior POST /agent/config call has been made (fresh install / keyring empty).
        // The smart-layer falls back to its stored config if these are empty.
        const providerInfo = yield* provider
          .getProvider(model.providerID)
        process.stderr.write(
          `[TRACE-delegate] ⑤j providerInfo ok (hasKey=${!!(providerInfo as any)?.key}, hasBaseURL=${!!(providerInfo as any)?.options?.baseURL})\n`,
        )
        // Prefer provider-level baseURL, fall back to model-level api.url
        const providerBaseUrl: string | undefined =
          ((providerInfo as any)?.options?.baseURL as string | undefined) || (model.api as any)?.url || undefined
        const providerApiKey: string | undefined =
          ((providerInfo as any)?.key as string | undefined) ??
          ((providerInfo as any)?.env as string[] | undefined)?.find((e: string) => !!(process.env as any)[e])

        // ── Concurrent pre-flight (perf) ──
        // intent.clarify / getLoopConfig / ensureSession are three
        // independent, best-effort calls that previously ran SERIALLY
        // (wall-clock ≈ their sum). We fire them concurrently and only
        // proceed once ALL THREE complete. `ensureSession` still finishes
        // BEFORE `postRunLoop` (the Rust handler re-checks session
        // existence), so behaviour is identical — we just pay the
        // SLOWEST of the three, not their sum.
        let intentType: string | undefined
        const userText = Option.isSome(lastUserMsg) && lastUserMsg.value.info.role === "user"
          ? lastUserMsg.value.parts
            .filter((p): p is MessageV2.TextPart => p.type === "text")
            .map((p) => p.text.trim())
            .join(" ")
          : ""

        process.stderr.write(`[TRACE-delegate] ⑤k+⑤l+⑥ calling intent.clarify / getLoopConfig / ensureSession concurrently...\n`)
        const [clarification, loopCfg, _sess] = yield* Effect.all(
          [
            userText
              ? Effect.tryPromise({
                  // camelCase: IntentClarifyRequest (common.rs) renames; the
                  // old `user_input` key never matched → required-field 400.
                  try: () => clients.intent.clarify({ userInput: userText }),
                  catch: (e) => new Cause.UnknownError(e),
                }).pipe(
                  Effect.orElseSucceed(() => {
                    process.stderr.write(`[TRACE-delegate] ⑤k intent.clarify failed (non-critical)\n`)
                    return undefined as { intentType?: string; confidence?: number } | undefined
                  }),
                )
              : Effect.succeed(undefined as { intentType?: string; confidence?: number } | undefined),
            Effect.tryPromise({
              try: () => clients.agent.getLoopConfig(),
              catch: (e) => (e instanceof Error ? e : new DuoduoError({ message: String(e), cause: e })),
            }).pipe(Effect.orElseSucceed(() => undefined)),
            Effect.tryPromise({
              try: () => clients.agent.ensureSession(sessionID, ctx.worktree ?? ctx.directory),
              catch: (e) => (e instanceof Error ? e : new DuoduoError({ message: String(e), cause: e })),
            }).pipe(Effect.orElseSucceed(() => undefined)),
          ],
          { concurrency: 3 },
        )
        process.stderr.write(
          `[TRACE-delegate] ⑤k+⑤l+⑥ done: intent=${JSON.stringify(clarification)}, loopCfg=${JSON.stringify(loopCfg)}\n`,
        )
        if (clarification?.intentType) {
          intentType = clarification.intentType
          yield* elog.info("delegateToRustRunLoop: intent classified", {
            sessionID,
            intentType,
            confidence: clarification.confidence,
          })
        }

        // G7 (TS side): when parallel dispatch is enabled in the Rust LoopConfig,
        // perform a deterministic TS-side decomposition and send explicit
        // subTasks to postRunLoop. This is the "TS 显式下发" path — TS controls
        // the decomposition rather than the Rust planner. On any failure we fall
        // back to no subTasks (Rust planner / serial loop) with no behaviour change.
        let subTasks: SubTaskRequest[] | undefined
        if (loopCfg?.parallelDispatch && Option.isSome(lastUserMsg)) {
          if (userText) {
            process.stderr.write(`[TRACE-delegate] ⑤l parallel_dispatch on; TS decomposing task\n`)
            subTasks = yield* decomposeTask({
              user: lastUserMsg.value.info,
              task: userText,
              model,
              agentName,
              sessionID,
            }).pipe(Effect.orElseSucceed(() => undefined))
            process.stderr.write(
              `[TRACE-delegate] ⑤l TS decomposition produced ${subTasks?.length ?? 0} sub-tasks\n`,
            )
          }
        }

        // ── Authoritative conversation history for Rust (invariant guard) ──
        // The Rust runLoop reconstructs history from the per-project DB. If the
        // user message failed to land there (DB relocation / write-path
        // regressions), the loop would run with ZERO user input and the LLM
        // could call tools arbitrarily (root cause of the "greeting triggers
        // tool calls" bug). We therefore always pass the TS-side conversation
        // as `messages` in LlmMessage wire format; Rust falls back to it
        // whenever its DB copy lacks any user message.
        const historyMsgs = yield* sessions
          .messages({ sessionID })
          .pipe(Effect.orElseSucceed(() => [] as MessageV2.WithParts[]))
        const reqMessages: Array<{ role: string; content: string }> = []
        for (const m of historyMsgs) {
          if (m.info.role !== "user" && m.info.role !== "assistant") continue
          const content = m.parts
            .filter((p): p is MessageV2.TextPart => p.type === "text" && p.ignored !== true)
            .map((p) => p.text)
            .filter(Boolean)
            .join("\n")
          if (content) reqMessages.push({ role: m.info.role, content })
        }
        // Hard invariant: the request MUST contain the latest user input. If
        // the DB read produced no user message at all, synthesize it from the
        // in-flight prompt text so Rust never sees a userless conversation.
        if (userText && !reqMessages.some((m) => m.role === "user")) {
          reqMessages.push({ role: "user", content: userText })
        }

        // ── P1: in-session conversation memory recall ──
        // Recover earlier decisions/context from THIS session's stored
        // memories (tags=["conversation"]) so follow-up questions in a long
        // task stay grounded even after compaction drops the tail. Filtered
        // client-side by sessionID because the search API only supports
        // project_path scoping, not session scoping.
        const memCtx = yield* InstanceState.context
        yield* Effect.tryPromise({
          try: async () => {
            const memClients = createSmartLayerClients()
            if (!memClients?.memory) return
            // The Rust search short-circuits empty queries ([R-04] guard in
            // memory-system/src/store.rs) and pure-punctuation queries degrade
            // to "any N entries" — so recall only runs with real user text.
            // The previous empty-string query made this whole block a no-op
            // (P1-12); the field match below is camelCase because MemoryEntry
            // serializes `sessionId`.
            const query = userText?.trim()
            if (!query) return
            const hits = await memClients.memory.search(
              query,
              20,
              undefined,
              ["conversation"],
              memCtx.directory,
            )
            const sessionMemories = hits
              .filter((h) => h.sessionId === sessionID)
              .map((h) => h.content)
              .filter(Boolean)
            if (sessionMemories.length > 0) {
              reqMessages.push({
                role: "system",
                content:
                  "相关会话记忆（来自本会话早期轮次，供参考）：\n" +
                  sessionMemories.map((c, i) => `${i + 1}. ${c}`).join("\n"),
              })
            }
          },
          catch: () => {
            // Memory recall is best-effort; never block the run loop on it.
          },
        }).pipe(Effect.ignore)

        yield* elog.info("delegateToRustRunLoop: calling postRunLoop", {
          sessionID,
          model: model.api.id,
          agent: agentName,
          hasBaseUrl: !!providerBaseUrl,
          hasApiKey: !!providerApiKey,
          providerID: model.providerID,
          intentType,
          historyMessages: reqMessages.length,
        })

        const result = yield* Effect.gen(function* () {
          // NOTE: `ensureSession` is now performed concurrently (above) and
          // has already completed BEFORE this gen runs, so the Rust
          // session-exists precondition still holds — behaviour identical.
          process.stderr.write(
            `[TRACE-delegate] ⑥ posting to Rust /agent/run_loop, model=${model.api.id}, agent=${agentName}\n`,
          )
          yield* elog.info("delegateToRustRunLoop: posting to Rust /agent/run_loop", { sessionID })
          yield* Effect.tryPromise({
            try: () =>
              clients.agent.postRunLoop(sessionID, {
                // Authoritative history fallback — see reqMessages assembly
                // above. Rust uses this whenever its DB history lacks a user
                // message (invariant guard against silent history loss).
                messages: reqMessages,
                tools: toolDefs,
                permission_rules: permissionRules,
                model: model.api.id,
                agent_name: agentName,
                project_path: ctx.directory,
                // Sandbox (road-2): forward the task-level allow-list so the
                // Rust loop scopes its own path-taking tools the same way the
                // TS side does via Instance.containsPath. Without this the two
                // halves disagree — TS would gate an out-of-bounds write while
                // Rust (which owns the main loop) would let it through.
                // `runAgentTurn` populated these on the shared InstanceContext.
                allowedPaths: ctx.allowedPaths,
                snapshot_gitdir: snapshotGitdir,
                output_format: outputFormat,
                provider: model.providerID,
                base_url: providerBaseUrl,
                api_key: providerApiKey,
                intent_type: intentType,
                system_prompt: systemPrompt,
                // Model context window (tokens) from the registry. Enables
                // Rust-side pre-flight compression so long conversations don't
                // overflow the LLM context limit. `model.limit.context` is a
                // required positive number on every registry model.
                context_window: model.limit.context,
                // Prompt caching: tell Rust whether this provider accepts
                // `cache_control`. The TS path already gates caching on this
                // capability (ProviderTransform.applyCaching); the Rust path
                // previously had no signal and therefore never cached, re-billing
                // the whole system prefix every round.
                prompt_caching: model.capabilities?.promptCaching ?? false,
                // Progressive tool disclosure: ON by default for all users — no
                // env var needed. Rust sends non-core tools as name-only stubs
                // and reveals their schemas on demand via the synthetic
                // `expand_tools` tool, so the full tool catalogue isn't re-sent
                // every round. Default ON; the only way to disable it is to set
                // DUODUO_PROGRESSIVE_TOOLS=false explicitly (escape hatch for
                // provider incompatibility). Any other value (unset, "true",
                // "1") keeps it ON.
                progressive_tools: process.env.DUODUO_PROGRESSIVE_TOOLS?.toLowerCase() !== "false",
                // G7 explicit sub-task list (TS-side deterministic decomposition).
                // When present, Rust uses these directly instead of its planner.
                subTasks,
                // Honor the user's "auto-accept permissions" switch so sub-agents
                // (interactive=false) treat `Ask` as `Allow` and don't block
                // night-time autonomous work on confirmation prompts.
                autoAccept,
                // Sampling temperature resolved from the model's configured value
                // (falls back to ProviderTransform.temperature's per-model default).
                // This overrides the Rust-side LlmConfig.temperature, making the
                // model-level setting the single source of truth.
                temperature: ProviderTransform.temperature(model),
              }),
            catch: (e) => {
              throw new NamedError.Unknown({
                message: `Rust runLoop trigger failed: ${e instanceof Error ? e.message : String(e)}`,
              })
            },
          }).pipe(
            Effect.tapError((e) =>
              elog.error("delegateToRustRunLoop: postRunLoop failed", { sessionID, error: String(e) }),
            ),
          )
          process.stderr.write(`[TRACE-delegate] ⑦ postRunLoop ok, starting poll\n`)
          yield* elog.info("delegateToRustRunLoop: postRunLoop ok, starting poll", { sessionID })
          // DEBUG timing (debug-level only; no effect on normal logic).
          yield* elog.debug("timing: postRunLoop ok (context+RAG assembly done)", {
            sessionID,
            ms: Date.now() - delegateT0,
          })
          // Poll DB with pending-tool detection until the Rust runLoop completes.
          return yield* rustRunLoopPoll(sessionID)
        }).pipe(
          // 无论成功/失败/中断，都恢复 idle（镜像 processor.ts:794 的 cleanup() 模式）
          Effect.ensuring(status.set(sessionID, { type: "idle" })),
        )

        // Post-delegation side effects (preserved from old TS runLoop path)
        process.stderr.write(
          `[TRACE-post] ⑨ post-loop side effects start, role=${result.info.role}, finish=${(result.info as any).finish}\n`,
        )

        // 1. Store conversation memory (fire-and-forget)
        process.stderr.write(`[TRACE-post] ⑨-1 storeConversationMemory start\n`)
        const finalMsgs = yield* MessageV2.filterCompactedEffect(sessionID)
        process.stderr.write(`[TRACE-post] ⑨-1 filterCompacted ok, msgs=${finalMsgs.length}\n`)
        yield* completion.storeConversationMemory(sessionID, finalMsgs).pipe(
// @effect-diagnostics-next-line catchUnfailableEffect:off
          Effect.catch(() => Effect.void),
          Effect.forkIn(scope),
        )
        process.stderr.write(`[TRACE-post] ⑨-1 storeConversationMemory forked\n`)

        // 2. Code review (cascadeQA) — previously a fire-and-forget fork of a
        // separate review session lived here. That fork never flowed its results
        // back into the main loop (verified), so it was removed (zero-risk
        // convergence, P7.4/G5). The review prompt remains preparable via
        // `triggerCodeReview` when an explicit review is desired; the planned
        // annotation-based回流 is tracked as a known boundary (see plan §8.4).

        // 3. Compaction prune (fire-and-forget)
        process.stderr.write(`[TRACE-post] ⑨-3 compaction.prune start\n`)
        yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
        process.stderr.write(`[TRACE-post] ⑨-3 compaction.prune forked\n`)

        // 4. Session summary (fire-and-forget) — mirrors TS processor.ts L449-457
        // which triggered summary.summarize after each finish-step.
        const resultParentID = (result.info as MessageV2.Assistant).parentID
        if (resultParentID) {
          process.stderr.write(`[TRACE-post] ⑨-4 summarize start, parentID=${resultParentID}\n`)
          yield* summary.summarize({ sessionID, messageID: resultParentID }).pipe(
            Effect.catchCause((cause) => elog.warn("summary.summarize failed", { cause: String(cause) })),
            Effect.forkIn(scope),
          )
          process.stderr.write(`[TRACE-post] ⑨-4 summarize forked\n`)
        }

        // 5. Check if the Rust runLoop ended due to context overflow — if so, trigger
        // compaction and retry delegateToRustRunLoop (mirrors TS processor.ts halt() L688-718
        // which sets needsCompaction=true, causing the old runLoop to compact + retry).
        const resultInfo = result.info as MessageV2.Assistant
        if (resultInfo.finish === "error" && resultInfo.error) {
          const errorMsg =
// @effect-diagnostics-next-line preferSchemaOverJson:off
            typeof resultInfo.error === "object" ? JSON.stringify(resultInfo.error) : String(resultInfo.error)
          if (errorMsg.includes("context_overflow")) {
            process.stderr.write(`[TRACE-post] ⑨-5 context overflow detected\n`)
            yield* elog.info("context overflow detected, triggering compaction", { sessionID })
            const session = yield* sessions.get(sessionID)
            const msgs = yield* sessions.messages({ sessionID })
            const lastUser = msgs.findLast((m) => m.info.role === "user")
            if (lastUser) {
              const compactResult = yield* compaction
                .process({
                  parentID: lastUser.info.id,
                  sessionID,
                  messages: msgs,
                  auto: true,
                  overflow: true,
                })
                .pipe(
                  Effect.catch((e) => elog.warn("compaction failed after overflow", { sessionID, error: String(e) })),
                  Effect.option,
                )
              // If compaction succeeded, retry delegateToRustRunLoop (with depth limit)
              if (Option.isSome(compactResult)) {
                if (overflowRetries < MAX_OVERFLOW_RETRIES) {
                  overflowRetries++
                  yield* elog.info("compaction completed, retrying delegateToRustRunLoop", {
                    sessionID,
                    attempt: overflowRetries,
                  })
                  return yield* delegateToRustRunLoop(sessionID, autoAccept)
                }
                yield* elog.warn("compaction retry limit reached, returning last error", {
                  sessionID,
                  attempts: overflowRetries,
                })
                // Fall through to return the original overflow error result —
                // user sees the overflow error card in UI and can manually retry.
              }
            }
          }
        }

        process.stderr.write(`[TRACE-post] ⑩ post-loop side effects done, returning result\n`)
        return result
      })

    // Output-limit (max_tokens) degradation retry wrapper around
    // delegateToRustRunLoop. When the LLM API rejects the request because
    // max_tokens exceeds the model's real output limit, retry with a smaller
    // value, walking down a fixed ladder. The first value that succeeds is
    // cached (persistDiscoveredOutputLimit) so later turns skip the retry.
    // This is zero-risk: it only activates on an actual failure; the cached
    // value is always one that just succeeded; mis-detection merely retries
    // with smaller max_tokens (more conservative, never breaks other logic).
    const OUTPUT_RETRY_LADDER = [32_000, 16_000, 8_000, 4_000, 2_000]

    const isMaxTokensError = (error: unknown): boolean => {
      const text = typeof error === "string" ? error : JSON.stringify(error)
      return /max_tokens/i.test(text)
    }

    const delegateToRustRunLoopWithOutputRetry: (
      sessionID: SessionID,
      autoAccept?: boolean,
    ) => Effect.Effect<MessageV2.WithParts, unknown, unknown> = Effect.fn(
      "SessionPrompt.delegateToRustRunLoopWithOutputRetry",
    )(function* (sessionID: SessionID, autoAccept?: boolean) {
      let result = yield* delegateToRustRunLoop(sessionID, autoAccept)
      if ((result.info as MessageV2.Assistant).finish !== "error") return result

// @effect-diagnostics-next-line preferSchemaOverJson:off
      const errorMsg = JSON.stringify((result.info as MessageV2.Assistant).error ?? "")
      if (!isMaxTokensError(errorMsg)) return result

      // Walk the ladder: each step lowers the output limit (via the discovered
      // cache that delegateToRustRunLoop reads when building its request) and
      // retries. The cache is in-memory only — it never mutates persisted or
      // user config.
      for (const nextOutput of OUTPUT_RETRY_LADDER) {
        process.stderr.write(`[TRACE-output-retry] max_tokens error, retrying with output=${nextOutput}\n`)
        yield* elog.info("output limit too high, retrying with smaller max_tokens", { sessionID, nextOutput })
        // Resolve the real model for this session (mirrors delegateToRustRunLoop)
        // so the cache key matches and the value is stored against the right model.
        const lastUser = yield* sessions.findMessage(
          sessionID,
          (m) => m.info.role === "user" && !!m.info.model,
        )
        const modelRef = Option.isSome(lastUser) && lastUser.value.info.role === "user"
          ? lastUser.value.info.model
          : undefined
        if (modelRef) {
          const model = yield* getModel(modelRef.providerID, modelRef.modelID, sessionID)
          if (model) persistDiscoveredOutputLimit(model, nextOutput)
        }
        result = yield* delegateToRustRunLoop(sessionID, autoAccept)
        if ((result.info as MessageV2.Assistant).finish !== "error") return result
// @effect-diagnostics-next-line preferSchemaOverJson:off
        if (!isMaxTokensError(JSON.stringify((result.info as MessageV2.Assistant).error ?? ""))) return result
      }
      // Exhausted the ladder — return the last error result as-is.
      return result
    })

    const runAgentTurn: (
      input: z.infer<typeof AgentTurnInput>,
    ) => Effect.Effect<MessageV2.WithParts, unknown, unknown> = Effect.fn("SessionPrompt.runAgentTurn")(function* (
      input: z.infer<typeof AgentTurnInput>,
    ) {
      // Sandbox (road-2): register task-level allowed paths before the turn.
      // Runs inside the Instance async-local context, so Instance.addAllowedPath
      // mutates the same ctx that file tools / bash scans read via containsPath.
      if (input.allowedPaths?.length) {
        for (const p of input.allowedPaths) Instance.addAllowedPath(p)
      }
      process.stderr.write(`[TRACE-runAgentTurn] entering delegateToRustRunLoopWithOutputRetry\n`)
      const res = yield* delegateToRustRunLoopWithOutputRetry(input.sessionID, input.autoAccept)
      process.stderr.write(`[TRACE-runAgentTurn] delegateToRustRunLoopWithOutputRetry returned ok\n`)
      return res
    })

    const shellInterrupted = Effect.fn("SessionPrompt.shellInterrupted")(function* (input: ShellInput) {
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          const agent = yield* agents.get(input.agent)
          if (!agent) return yield* lastAssistantSafe(input.sessionID)
          const model = input.model ?? agent.model ?? (yield* lastModel(input.sessionID))
          const userMsg: MessageV2.User = {
            id: input.messageID ?? MessageID.ascending(),
            sessionID: input.sessionID,
            time: { created: Date.now() },
            role: "user",
            agent: input.agent,
            model: { providerID: model.providerID, modelID: model.modelID },
          }
          yield* sessions.updateMessage(userMsg)
          const msg: MessageV2.Assistant = {
            id: MessageID.ascending(),
            sessionID: input.sessionID,
            parentID: userMsg.id,
            mode: input.agent,
            agent: input.agent,

            path: { cwd: ctx.directory, root: ctx.worktree },
            time: { created: Date.now() },
            role: "assistant",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: model.modelID,
            providerID: model.providerID,
          }
          yield* sessions.updateMessage(msg)
          const output = ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
          const part: MessageV2.ToolPart = {
            type: "tool",
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: input.sessionID,
            tool: "bash",
            callID: ulid(),
            state: {
              status: "completed",
              time: { start: Date.now(), end: Date.now() },
              input: { command: input.command },
              title: "",
              metadata: { output, description: "" },
              output,
            },
          }
          yield* sessions.updatePart(part)
          return { info: msg, parts: [part] }
        }),
      )
    })

    const shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts, unknown, unknown> = Effect.fn(
      "SessionPrompt.shell",
    )(function* (input: ShellInput) {
      const interrupted = shellInterrupted(input).pipe(Effect.orDie) as Effect.Effect<MessageV2.WithParts>
      return yield* state.startShell(input.sessionID, interrupted, shellImpl(input))
    })

    const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
      yield* elog.info("command", { sessionID: input.sessionID, command: input.command, agent: input.agent })
      const cmd = yield* commands.get(input.command)
      if (!cmd) {
        const available = (yield* commands.list()).map((c) => c.name)
        const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }
      const agentName = cmd.agent ?? input.agent ?? (yield* agents.defaultAgent())

      const raw = input.arguments.match(argsRegex) ?? []
      const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
      const templateCommand = yield* Effect.promise(async () => cmd.template)

      const placeholders = templateCommand.match(placeholderRegex) ?? []
      let last = 0
      for (const item of placeholders) {
        const value = Number(item.slice(1))
        if (value > last) last = value
      }

      const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
        const position = Number(index)
        const argIndex = position - 1
        if (argIndex >= args.length) return ""
        if (position === last) return args.slice(argIndex).join(" ")
        return args[argIndex] ?? ""
      })
      const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
      let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

      if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
        template = template + "\n\n" + input.arguments
      }

      const shellMatches = ConfigMarkdown.shell(template)
      if (shellMatches.length > 0) {
        const sh = Shell.preferred()
        const results = yield* Effect.promise(() =>
          Promise.all(
            shellMatches.map(async ([, cmd]) => (await Process.text([cmd!], { shell: sh, nothrow: true })).text),
          ),
        )
        let index = 0
        template = template.replace(bashRegex, () => results[index++]!)
      }
      template = template.trim()

      const taskModel = yield* Effect.gen(function* () {
        if (cmd.model) return Provider.parseModel(cmd.model)
        if (cmd.agent) {
          const cmdAgent = yield* agents.get(cmd.agent)
          if (cmdAgent?.model) return cmdAgent.model
        }
        if (input.model) return Provider.parseModel(input.model)
        return yield* lastModel(input.sessionID)
      })

      yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

      const agent = yield* agents.get(agentName)
      if (!agent) {
        const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
        const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
        const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
        yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
        throw error
      }

      const templateParts = yield* resolvePromptParts(template)
      const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
      const parts = isSubtask
        ? [
            {
              type: "subtask" as const,
              agent: agent.name,
              description: cmd.description ?? "",
              command: input.command,
              model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
              prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
            },
          ]
        : [...templateParts, ...(input.parts ?? [])]

      const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultAgent())) : agentName
      const userModel = isSubtask
        ? input.model
          ? Provider.parseModel(input.model)
          : yield* lastModel(input.sessionID)
        : taskModel

      const result = yield* prompt({
        sessionID: input.sessionID,
        messageID: input.messageID,
        model: userModel,
        agent: userAgent,
        parts,
        variant: input.variant,
        autoAccept: input.autoAccept,
      })
      yield* bus.publish(Command.Event.Executed, {
        name: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
        messageID: result.info.id,
      })
      return result
    })

    return Service.of({
      cancel,
      prompt,
      runAgentTurn,
      shell,
      command,
      resolvePromptParts,
    })
  }),
)

// defaultLayer provides all dependencies — used when SessionPrompt is used standalone.
//
// Restructured to avoid `Layer.mergeAll` building interdependent layers in parallel:
// only the pure-consumer layers stay in `mergeAll`; every layer that *provides* a
// service required by another layer in this bag is hoisted via `Layer.provideMerge`
// so it is built (and memoized) before its consumers. Effect resolves any remaining
// provider→provider edges lazily through the shared memo map.
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        SessionCompaction.defaultLayer,
        Command.defaultLayer,
        ToolRegistry.defaultLayer,
        Agent.defaultLayer,
        SystemPrompt.defaultLayer,
      ).pipe(
        Layer.provideMerge(SessionRunState.defaultLayer),
        Layer.provideMerge(SessionStatus.defaultLayer),
        Layer.provideMerge(Permission.defaultLayer),
        Layer.provideMerge(MCP.defaultLayer),
        Layer.provideMerge(LSP.defaultLayer),
        Layer.provideMerge(Truncate.defaultLayer),
        Layer.provideMerge(Provider.defaultLayer),
        Layer.provideMerge(Instruction.defaultLayer),
        Layer.provideMerge(AppFileSystem.defaultLayer),
        Layer.provideMerge(Session.defaultLayer),
        Layer.provideMerge(SessionRevert.defaultLayer),
        Layer.provideMerge(SessionSummary.defaultLayer),
        Layer.provideMerge(SessionCompletion.defaultLayer),
        Layer.provideMerge(LLM.defaultLayer),
        Layer.provideMerge(Bus.layer),
        Layer.provideMerge(Todo.defaultLayer),
        Layer.provideMerge(CrossSpawnSpawner.defaultLayer),
      ),
    ),
    Layer.provide(Config.defaultLayer),
  ),
)

// appLayerDeps is a legacy alias for SessionPrompt.layer, kept for backward compatibility.
// AppLayer now uses SessionPrompt.layer directly with all dependencies resolved at the top level.
export const appLayerDeps = layer as any
export const PromptInput = z.object({
  sessionID: SessionID.zod,
  messageID: MessageID.zod.optional(),
  promptID: z.string().optional(),
  blackboardOwner: z.boolean().optional(),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    })
    .optional(),
  agent: z.string().optional(),
  noReply: z.boolean().optional(),
  cascadeQA: z.boolean().optional(),
  /** Whether the user's "auto-accept permissions" switch is on for this
   *  session/directory. When true, sub-agents (non-interactive) treat an
   *  `Ask` permission result as `Allow`, so autonomous work isn't blocked by
   *  confirmation prompts. Plumbed through to Rust's runLoop `auto_accept`. */
  autoAccept: z.boolean().optional(),
  tools: z
    .record(z.string(), z.boolean())
    .optional()
    .describe("@deprecated tools and permissions have been merged, you can set permissions on the session itself now"),
  format: MessageV2.Format.zod.optional(),
  system: z.string().optional(),
  locale: z
    .string()
    .min(2)
    .max(35)
    .optional()
    .describe(
      "BCP-47 locale tag of the user's UI (e.g., 'zh', 'zh-Hans', 'en'). " +
        "When set, the assistant is instructed to respond in this language regardless of the user's message language.",
    ),
  variant: z.string().optional(),
  /** Origin of the prompt. `"feishu"` marks prompts driven by the Feishu IM
   *  bridge (the user is away from the keyboard), so the desktop client can
   *  auto-switch to the session when the message lands. Absent/`"ide"` means a
   *  normal in-app send. */
  origin: z.enum(["feishu", "ide"]).optional(),
  parts: z.array(
    z.discriminatedUnion("type", [
      MessageV2.TextPartInput.zod as unknown as z.ZodObject<any>,
      MessageV2.FilePartInput.zod as unknown as z.ZodObject<any>,
      MessageV2.AgentPartInput.zod as unknown as z.ZodObject<any>,
      MessageV2.SubtaskPartInput.zod as unknown as z.ZodObject<any>,
    ]),
  ),
})
// `z.discriminatedUnion` erases the discriminated members' shapes back to
// `{}` because the derived `.zod` on each input is typed as an opaque
// `z.ZodType`. Restore the precise `parts` type from the exported Schema
// input types so callers see a proper tagged union.
type PartInputUnion =
  | MessageV2.TextPartInput
  | MessageV2.FilePartInput
  | MessageV2.AgentPartInput
  | MessageV2.SubtaskPartInput
export type PromptInput = Omit<z.infer<typeof PromptInput>, "parts"> & {
  parts: PartInputUnion[]
}

export const AgentTurnInput = z.object({
  sessionID: SessionID.zod,
  /** Whether the user's "auto-accept permissions" switch is on. Plumbed to
   *  Rust's runLoop so sub-agents treat `Ask` as `Allow` (option B). */
  autoAccept: z.boolean().optional(),
  /**
   * Sandbox (road-2) task-level allowed paths. Paths listed here are treated
   * as in-bounds for the current session — files/bash targets under them do
   * NOT trigger the external_directory ask gate. Enables cross-project tasks
   * ("read code in project A, program in project B") without loosening the
   * global sandbox. Each entry is resolved to an absolute normalized path.
   */
  allowedPaths: z.array(z.string()).optional(),
})

export const ShellInput = z.object({
  sessionID: SessionID.zod,
  messageID: MessageID.zod.optional(),
  agent: z.string(),
  model: z
    .object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
    })
    .optional(),
  command: z.string(),
})
export type ShellInput = z.infer<typeof ShellInput>

export const CommandInput = z.object({
  messageID: MessageID.zod.optional(),
  sessionID: SessionID.zod,
  agent: z.string().optional(),
  model: z.string().optional(),
  arguments: z.string(),
  command: z.string(),
  variant: z.string().optional(),
  /** Whether the user's "auto-accept permissions" switch is on. Plumbed through
   *  to the delegated runLoop's `auto_accept` so sub-agents treat `Ask` as
   *  `Allow`. Mirrors `PromptInput.autoAccept`. */
  autoAccept: z.boolean().optional(),
  // Inlined (no `.meta({ ref })`) to keep the original SDK output — the
  // PromptInput call site below references FilePartInput by ref via the
  // Schema export in message-v2.ts.
  parts: z
    .array(
      z.discriminatedUnion("type", [
        z.object({
          id: PartID.zod.optional(),
          type: z.literal("file"),
          mime: z.string(),
          filename: z.string().optional(),
          url: z.string(),
          source: MessageV2.FilePartSource.zod.optional(),
        }),
      ]),
    )
    .optional(),
})
export type CommandInput = z.infer<typeof CommandInput>

/** @internal Exported for testing */
export function createStructuredOutputTool(input: {
  schema: Record<string, any>
  onSuccess: (output: unknown) => void
}): AITool {
  // Remove $schema property if present (not needed for tool input)
  const { $schema: _, ...toolSchema } = input.schema

  return tool({
    description: STRUCTURED_OUTPUT_DESCRIPTION,
    inputSchema: jsonSchema(toolSchema as JSONSchema7),
    async execute(args) {
      // AI SDK validates args against inputSchema before calling execute()
      input.onSuccess(args)
      return {
        output: "Structured output captured successfully.",
        title: "Structured Output",
        metadata: { valid: true },
      }
    },
    toModelOutput({ output }) {
      return {
        type: "text",
        value: output.output,
      }
    },
  })
}
const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export * as SessionPrompt from "./prompt"
