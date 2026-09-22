import { Layer, ManagedRuntime } from "effect"
import { attach } from "./run-service"
import * as Observability from "./observability"

import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { NodeFileSystem } from "@effect/platform-node"
import { NodePath } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { Global } from "../global"
import { EffectFlock } from "@duoduo-ai/shared/util/effect-flock"
import { Bus } from "@/bus"
import { Auth } from "@/auth"
import { Config } from "@/config"
import { Git } from "@/git"
import { Ripgrep } from "@/file/ripgrep"
import { File } from "@/file"
import { FileWatcher } from "@/file/watcher"
import { Storage } from "@/storage"
import { Snapshot } from "@/snapshot"

import { Provider, ProviderAuth } from "@/provider"
import { Agent } from "@/agent/agent"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Question } from "@/question"
import { Permission } from "@/permission"
import { Todo } from "@/session/todo"
import { Session } from "@/session"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionProcessor } from "@/session/processor"
import { SessionCompaction } from "@/session/compaction"
import { SessionRevert } from "@/session/revert"
import { SessionSummary } from "@/session/summary"
import { SessionPrompt } from "@/session/prompt"
import { CascadeService, cascadeLayer } from "@/quality/cascade"
import { SessionCompletion } from "@/session/completion"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { LSP } from "@/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Command } from "@/command"
import { Truncate } from "@/tool"
import { ToolRegistry } from "@/tool"
import { Format } from "@/format"
import { Project } from "@/project"
import { Vcs } from "@/project"
import { GraphIndexStatus } from "@/project/graph-index-status"
import { Worktree } from "@/worktree"
import { Pty } from "@/pty"
import { Installation } from "@/installation"
import { Npm } from "@/npm"
import { Env } from "@/env"
import { SystemPrompt } from "@/session/system"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { Log } from "@/util"

// ─────────────────────────────────────────────────────────────────────────────
// AppLayer Architecture
// ─────────────────────────────────────────────────────────────────────────────
//
// ALL layers in mergeAll use `defaultLayer` variants (self-contained, RIn=never).
// Each defaultLayer internally provides its own dependencies via Layer.provide,
// but those internal provisions are transparent to mergeAll — they only affect
// the defaultLayer's own output, not the merged result.
//
// VERIFIED (test-layer-root-cause.ts):
// - mergeAll does NOT auto-satisfy internal deps between members
// - defaultLayer's internal Layer.provide does NOT consume services from mergeAll
// - All services from all defaultLayers are present in the final output
//
// Bare `layer` is used ONLY for:
// - Layers with no service deps (Bus.layer, cascadeLayer, etc.)
// - Layers with no defaultLayer variant (AccountRepo.layer)
// - Test files where you inject mocks
//
// After mergeAll, `provideMerge` re-exposes infrastructure services that
// external consumers need. The chain builds OUTSIDE-IN: the LAST .pipe()
// is built first.
//
// Each ManagedRuntime uses its own memoMap to prevent cross-runtime Scope
// contamination (see ensureRuntimeHealth below).
// ─────────────────────────────────────────────────────────────────────────────

// Restructured to avoid `Layer.mergeAll` building interdependent layers in parallel
// (which can fail at build time when a layer needs a service provided by a sibling).
// Only the pure-consumer layers remain in `mergeAll`; every layer that *provides* a
// service required by another layer in this bag is hoisted via `Layer.provideMerge`
// so it is built (and memoized) before its consumers. Effect resolves any remaining
// provider→provider edges lazily through the shared memo map.
// @effect-diagnostics-next-line unnecessaryPipeChain:off
export const AppLayer = Layer.mergeAll(
  Skill.defaultLayer,
  SessionProcessor.defaultLayer,
  SessionCompaction.defaultLayer,
  Command.defaultLayer,
  ToolRegistry.defaultLayer,
  SessionPrompt.defaultLayer,
  SystemPrompt.defaultLayer,
)
  .pipe(
    // Consumer layers. Each defaultLayer internally provides its own
    // dependencies (see header comment), so cross-consumer wiring is handled
    // there. Foundational infra is NOT provided here — see the final `.pipe()`.
    Layer.provideMerge(Auth.defaultLayer),
    Layer.provideMerge(Config.defaultLayer),
    Layer.provideMerge(Git.defaultLayer),
    Layer.provideMerge(Ripgrep.defaultLayer),
    Layer.provideMerge(File.defaultLayer),
    Layer.provideMerge(FileWatcher.defaultLayer),
    Layer.provideMerge(Storage.defaultLayer),
    Layer.provideMerge(Snapshot.defaultLayer),
  )
  .pipe(
    Layer.provideMerge(Provider.defaultLayer),
    Layer.provideMerge(ProviderAuth.defaultLayer),
    Layer.provideMerge(Agent.defaultLayer),
    Layer.provideMerge(Discovery.defaultLayer),
    Layer.provideMerge(Question.defaultLayer),
    Layer.provideMerge(Permission.defaultLayer),
    Layer.provideMerge(Todo.defaultLayer),
    Layer.provideMerge(Session.defaultLayer),
    Layer.provideMerge(SessionStatus.defaultLayer),
    Layer.provideMerge(SessionRunState.defaultLayer),
    Layer.provideMerge(SessionRevert.defaultLayer),
    Layer.provideMerge(SessionSummary.defaultLayer),
    Layer.provideMerge(SessionCompletion.defaultLayer),
    Layer.provideMerge(Instruction.defaultLayer),
    Layer.provideMerge(LLM.defaultLayer),
    Layer.provideMerge(LSP.defaultLayer),
    Layer.provideMerge(MCP.defaultLayer),
  )
  .pipe(
    Layer.provideMerge(McpAuth.defaultLayer),
    Layer.provideMerge(Truncate.defaultLayer),
    Layer.provideMerge(Format.defaultLayer),
    Layer.provideMerge(Project.defaultLayer),
    Layer.provideMerge(Vcs.defaultLayer),
    Layer.provideMerge(GraphIndexStatus.defaultLayer),
    Layer.provideMerge(Worktree.defaultLayer),
    Layer.provideMerge(Pty.defaultLayer),
    Layer.provideMerge(Installation.defaultLayer),
    Layer.provideMerge(Npm.defaultLayer),
    Layer.provideMerge(EffectFlock.layer),
    Layer.provideMerge(CrossSpawnSpawner.defaultLayer),
    Layer.provideMerge(cascadeLayer),
  )
  .pipe(
    // ─── Foundational infrastructure LAST (outermost) ──────────────────────────
    // In the bundled Effect version, `Layer.provideMerge(that)` provides `that`'s
    // services to the *current* accumulated layer but does NOT forward them to
    // later `provideMerge` steps. So any service that depends on one of these
    // base services (Global / FileSystem / Bus / ...) must be provided BEFORE
    // this point — which every consumer above is. Providing these base services
    // LAST makes them wrap the entire chain, so they are visible to every
    // consumer and to the mergeAll members. This is the root-cause fix for the
    // "Service not found: @duoduo/Global" (and the analogous FileSystem/Bus/...)
    // errors on startup. Order within this group: leaf services (NodeFileSystem,
    // NodePath, FetchHttpClient, Env) before the ones built on top of them
    // (AppFileSystem), then Bus, Observability, and finally Global.
    Layer.provideMerge(NodeFileSystem.layer),
    Layer.provideMerge(NodePath.layer),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Env.layer),
    Layer.provideMerge(AppFileSystem.defaultLayer),
    Layer.provideMerge(Bus.defaultLayer),
    Layer.provideMerge(Observability.layer as any),
    Layer.provideMerge(Global.layer),
  ) as any

let appMemoMap = Layer.makeMemoMapUnsafe()
let rt = ManagedRuntime.make(AppLayer, { memoMap: appMemoMap })

// Warmup (server.ts) builds each local service's self-contained layer through its
// OWN ManagedRuntime that shares this memo map. That builds only the service's
// subgraph (never MCP/LSP/Command), while real requests via `AppRuntime` reuse the
// memoized local sub-layers and lazily build external-process services on first use.
export const getAppMemoMap = () => appMemoMap

type Runtime = Pick<typeof rt, "runSync" | "runPromise" | "runPromiseExit" | "runFork" | "runCallback" | "dispose">
const wrap = (effect: Parameters<typeof rt.runSync>[0]) => attach(effect as never) as never

function ensureRuntimeHealth() {
  try {
    // Attempt to access the cached context. If the ManagedRuntime was
    // disposed (e.g. after a ScopedCache invalidation cascade), this
    // will throw. In that case, recreate the runtime so the next
    // run* call gets a fresh context built from scratch.
    const context = rt.context()
    // Fire-and-forget, but NOT an unhandled one: while the AppLayer is still
    // building this promise stays pending, and disposing the runtime — which
    // tests do in a global afterAll (test/preload.ts) — interrupts the build
    // fiber. Every pending `context()` then rejected with nobody listening,
    // one unhandled rejection per run* call (~900 per test run, each becoming
    // a ##[error] annotation on CI).
    context?.catch(() => undefined)
  } catch {
    Log.Default.info("AppRuntime context was stale, recreating ManagedRuntime")
    appMemoMap = Layer.makeMemoMapUnsafe()
    rt = ManagedRuntime.make(AppLayer, { memoMap: appMemoMap })
  }
}

export const AppRuntime: Runtime = {
  runSync(effect) {
    ensureRuntimeHealth()
    return rt.runSync(wrap(effect))
  },
  runPromise(effect, options) {
    ensureRuntimeHealth()
    return rt.runPromise(wrap(effect), options)
  },
  runPromiseExit(effect, options) {
    ensureRuntimeHealth()
    return rt.runPromiseExit(wrap(effect), options)
  },
  runFork(effect) {
    ensureRuntimeHealth()
    return rt.runFork(wrap(effect))
  },
  runCallback(effect) {
    ensureRuntimeHealth()
    return rt.runCallback(wrap(effect))
  },
  dispose: () => rt.dispose(),
}
