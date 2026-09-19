import { PlanExitTool } from "./plan"
import { Session } from "../session"
import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import * as Tool from "./tool"
import { Config } from "../config"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@duoduo-ai/plugin"
import z from "zod"

import { Provider } from "../provider"
import { ProviderID, type ModelID } from "../provider/schema"
import { usePatchForModel } from "../session/system"
import { GraphQueryTool } from "./graph_query"
import { SymbolSearchTool } from "./symbol_search"
import { RecallMemoryTool } from "./recall_memory"
import {
  ProceedToInvestigateTool,
  ProceedToPlanTool,
  ProceedToExecuteTool,
  ProceedToVerifyTool,
} from "./proceed_to"
import { Flag } from "@/flag/flag"
import { Log } from "@/util"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { CodeCommentTool } from "./code_comment"
import {
  BlackboardReadTool,
  BlackboardWriteTool,
  BlackboardFindTool,
  BlackboardSubmitDraftTool,
  BlackboardSubmitStableTool,
  BlackboardAnnotateTool,
} from "./blackboard"
import { Glob } from "@duoduo-ai/shared/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { Ripgrep } from "../file/ripgrep"
import { Snapshot } from "@/snapshot"
import { SnapshotQueryTool } from "./snapshot_query"
import { Format } from "../format"
import { InstanceState } from "@/effect"
import { GraphIndexStatus } from "@/project/graph-index-status"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "../lsp"
import { Instruction } from "../session/instruction"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { Bus } from "../bus"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Permission } from "@/permission"

const log = Log.create({ service: "tool.registry" })

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  task: TaskDef
  read: ReadDef
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[], unknown, unknown>
  readonly all: () => Effect.Effect<Tool.Def[], unknown, unknown>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }, unknown, unknown>
  readonly tools: (model: {
    providerID: ProviderID
    modelID: ModelID
    agent: Agent.Info
  }) => Effect.Effect<Tool.Def[], unknown, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/ToolRegistry") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Config.Service
  | Question.Service
  | Todo.Service
  | Agent.Service
  | Skill.Service
  | Session.Service
  | Provider.Service
  | LSP.Service
  | Instruction.Service
  | AppFileSystem.Service
  | Bus.Service
  | HttpClient.HttpClient
  | ChildProcessSpawner
  | Ripgrep.Service
  | Format.Service
  | Truncate.Service
  | GraphIndexStatus.Service
  | Snapshot.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const agents = yield* Agent.Service
    const skill = yield* Skill.Service
    const truncate = yield* Truncate.Service

    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webfetch = yield* WebFetchTool
    const bash = yield* BashTool
    const graphquery = yield* GraphQueryTool
    const symbolsearch = yield* SymbolSearchTool
    const recallmemory = yield* RecallMemoryTool
    const proceedToInvestigate = yield* ProceedToInvestigateTool
    const proceedToPlan = yield* ProceedToPlanTool
    const proceedToExecute = yield* ProceedToExecuteTool
    const proceedToVerify = yield* ProceedToVerifyTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const skilltool = yield* SkillTool
    const commenttool = yield* CodeCommentTool
    const blackboardRead = yield* BlackboardReadTool
    const blackboardWrite = yield* BlackboardWriteTool
    const blackboardFind = yield* BlackboardFindTool
    const blackboardSubmitDraft = yield* BlackboardSubmitDraftTool
    const blackboardSubmitStable = yield* BlackboardSubmitStableTool
    const blackboardAnnotate = yield* BlackboardAnnotateTool
    const snapshotQuery = yield* SnapshotQueryTool
    const agent = yield* Agent.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []

        function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
          return {
            id,
            parameters: z.object(def.args),
            description: def.description,
            execute: (args, toolCtx) =>
              Effect.gen(function* () {
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  ask: (req) => toolCtx.ask(req),
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
                const output = typeof result === "string" ? result : result.output
                const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
                const info = yield* agent.get(toolCtx.agent)
                const out = yield* truncate.output(output, {}, info)
                return {
                  title: "",
                  output: out.truncated ? out.content : output,
                  metadata: {
                    ...metadata,
                    truncated: out.truncated,
                    ...(out.truncated && { outputPath: out.outputPath }),
                  },
                }
              }),
          }
        }

        const dirs = yield* config.directories()
        const matches = dirs.flatMap((dir) =>
          Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
        )
        if (matches.length) yield* config.waitForDependencies()
        for (const match of matches) {
          const namespace = path.basename(match, path.extname(match))
          // `match` is an absolute filesystem path from `Glob.scanSync(..., { absolute: true })`.
          // Import it as `file://` so Node on Windows accepts the dynamic import.
          const mod = yield* Effect.promise(() => import(pathToFileURL(match).href))
          for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
            custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
          }
        }

        yield* config.get()
        const questionEnabled =
          ["app", "cli", "desktop"].includes(Flag.DUODUO_CLIENT) || Flag.DUODUO_ENABLE_QUESTION_TOOL

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          bash: Tool.init(bash),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          fetch: Tool.init(webfetch),
          todo: Tool.init(todo),
          graph_query: Tool.init(graphquery),
          symbol_search: Tool.init(symbolsearch),
          recall_memory: Tool.init(recallmemory),
          skill: Tool.init(skilltool),
          patch: Tool.init(patchtool),
          code_comment: Tool.init(commenttool),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          plan: Tool.init(plan),
          blackboard_read: Tool.init(blackboardRead),
          blackboard_write: Tool.init(blackboardWrite),
          blackboard_find: Tool.init(blackboardFind),
          blackboard_submit_draft: Tool.init(blackboardSubmitDraft),
          blackboard_submit_stable: Tool.init(blackboardSubmitStable),
          blackboard_annotate: Tool.init(blackboardAnnotate),
          snapshot_query: Tool.init(snapshotQuery),
          proceed_to_investigate: Tool.init(proceedToInvestigate),
          proceed_to_plan: Tool.init(proceedToPlan),
          proceed_to_execute: Tool.init(proceedToExecute),
          proceed_to_verify: Tool.init(proceedToVerify),
        })

        return {
          custom,
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            tool.bash,
            tool.read,
            tool.glob,
            tool.grep,
            tool.edit,
            tool.write,
            tool.task,
            tool.fetch,
            tool.todo,
            tool.graph_query,
            tool.symbol_search,
            tool.recall_memory,
            tool.proceed_to_investigate,
            tool.proceed_to_plan,
            tool.proceed_to_execute,
            tool.proceed_to_verify,
            tool.skill,
            tool.patch,
            tool.code_comment,
            ...(Flag.DUODUO_EXPERIMENTAL_LSP_TOOL ? [tool.lsp] : []),
            ...(Flag.DUODUO_EXPERIMENTAL_PLAN_MODE && Flag.DUODUO_CLIENT === "cli" ? [tool.plan] : []),
            tool.blackboard_read,
            tool.blackboard_write,
            tool.blackboard_find,
            tool.blackboard_submit_draft,
            tool.blackboard_submit_stable,
            tool.blackboard_annotate,
            tool.snapshot_query,
          ],
          task: tool.task,
          read: tool.read,
        }
      }),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      return [...s.builtin, ...s.custom] as Tool.Def[]
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const describeSkill = Effect.fn("ToolRegistry.describeSkill")(function* (agent: Agent.Info) {
      const list = yield* skill.available(agent)
      if (list.length === 0) return "No skills are currently available."
      return [
        "Load a specialized skill that provides domain-specific instructions and workflows.",
        "",
        "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
        "",
        "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
        "",
        'Tool output includes a `<skill_content name="...">` block with the loaded content.',
        "",
        "The following skills provide specialized sets of instructions for particular tasks",
        "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
        "",
        Skill.fmt(list, { verbose: false }),
      ].join("\n")
    })

    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
      const items = (yield* agents.list()).filter((item) => item.mode !== "primary")
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const graphIndexSvc = yield* GraphIndexStatus.Service
      const graphIndexStatus = yield* graphIndexSvc.get()
      const filtered = (yield* all()).filter((tool) => {
        // 4-2: shared usePatch decision (system.ts usePatchForModel) — the
        // file-tool guidance wording must follow the same model gate.
        const usePatch = usePatchForModel(input.modelID)
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        // Only expose graph_query when knowledge graph is indexed and ready
        if (tool.id === GraphQueryTool.id) {
          return graphIndexStatus.type === "ready"
        }

        return true
      })

      return yield* Effect.forEach(
        filtered,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          using _ = log.time(tool.id)
          // 4-3: the per-tool graph_query recommendation sentences (grep/bash/
          // lsp descriptions) were removed — the recommendation lives in ONE
          // place, the searchStrategyGuidance in system.ts environment().
          const description = tool.description

          const output = {
            description,
            parameters: tool.parameters,
          }
          return {
            id: tool.id,
            description: [
              output.description,
              tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined,
              tool.id === SkillTool.id ? yield* describeSkill(input.agent) : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
            execute: tool.execute,
            // oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
            formatValidationError: tool.formatValidationError,
          }
        }),
        { concurrency: "unbounded" },
      )
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    return Service.of({ ids, all, named, tools })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Question.defaultLayer),
    Layer.provide(Todo.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(GraphIndexStatus.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
  ),
)
