import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { ConfigPermission } from "@/config/permission"
import { InstanceState } from "@/effect"
import { Instance } from "@/project/instance"
import { ProjectID } from "@/project/schema"
import { MessageID, SessionID } from "@/session/schema"
import { PermissionTable } from "@/session/session.sql"
import { Database, eq } from "@/storage"
import { zod } from "@/util/effect-zod"
import { Log } from "@/util"
import { withStatics } from "@/util/schema"
import { Wildcard } from "@/util"
import { Deferred, Effect, Layer, Schema, Context } from "effect"
import os from "os"
import { evaluate as evalRule } from "./evaluate"
import { PermissionID } from "./schema"

const log = Log.create({ service: "permission" })
const PLAN_CONFIRM_TIMEOUT = "5 minutes"
// 普通权限询问（edit/delete/bash 等）的独立超时，与 plan 确认分离。
// 之前两个分支误用同一个 PLAN_CONFIRM_TIMEOUT，导致普通询问实际套用了 plan 时长。
const PERMISSION_ASK_TIMEOUT = "2 minutes"

function summarizeRejectedPlan(info: Request, message?: string) {
  const metadata = info.metadata as Record<string, unknown>
  return JSON.stringify({
    permission: info.permission,
    patterns: info.patterns,
    feedback: message,
    filepath: typeof metadata["filepath"] === "string" ? metadata["filepath"] : undefined,
    source: typeof metadata["source"] === "string" ? metadata["source"] : undefined,
    promptID: typeof metadata["promptID"] === "string" ? metadata["promptID"] : undefined,
  })
}

async function rememberRejectedPlan(info: Request, message?: string) {
  if (info.permission !== "plan_confirm") return
  const { createSmartLayerClients } = await import("@/smart-layer")
  const clients = createSmartLayerClients()
  if (!clients?.memory) return
  clients.memory
    .updateProfile({
      content: summarizeRejectedPlan(info, message),
      category: "rejected_plan",
      userId: "default",
      // 7-4: explicit canonical project key (the worktree path) — the old
      // implicit "" row was only visible through the `OR project_id=''`
      // fallback and went invisible the moment any reader passed a real id.
      projectId: Instance.worktree,
      metadata: { source: "plan_confirm", requestID: info.id },
    })
    .catch(() => {})
}

export const Action = Schema.Literals(["allow", "deny", "ask"])
  .annotate({ identifier: "PermissionAction" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Action = Schema.Schema.Type<typeof Action>

export class Rule extends Schema.Class<Rule>("PermissionRule")({
  permission: Schema.String,
  pattern: Schema.String,
  action: Action,
}) {
  static readonly zod = zod(this)
}

export const Ruleset = Schema.mutable(Schema.Array(Rule))
  .annotate({ identifier: "PermissionRuleset" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Ruleset = Schema.Schema.Type<typeof Ruleset>

export class Request extends Schema.Class<Request>("PermissionRequest")({
  id: PermissionID,
  sessionID: SessionID,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  always: Schema.Array(Schema.String),
  tool: Schema.optional(
    Schema.Struct({
      messageID: MessageID,
      callID: Schema.String,
    }),
  ),
}) {
  static readonly zod = zod(this)
}

export const Reply = Schema.Literals(["once", "always", "reject"]).pipe(withStatics((s) => ({ zod: zod(s) })))
export type Reply = Schema.Schema.Type<typeof Reply>

const reply = {
  reply: Reply,
  message: Schema.optional(Schema.String),
}

export const ReplyBody = Schema.Struct(reply)
  .annotate({ identifier: "PermissionReplyBody" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReplyBody = Schema.Schema.Type<typeof ReplyBody>

export class Approval extends Schema.Class<Approval>("PermissionApproval")({
  projectID: ProjectID,
  patterns: Schema.Array(Schema.String),
}) {
  static readonly zod = zod(this)
}

export const Event = {
  Asked: BusEvent.define("permission.asked", Request.zod),
  Replied: BusEvent.define(
    "permission.replied",
    zod(
      Schema.Struct({
        sessionID: SessionID,
        requestID: PermissionID,
        reply: Reply,
      }),
    ),
  ),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
}) {
  override get message() {
    return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
  }
}

export type Error = DeniedError | RejectedError | CorrectedError

export const AskInput = Schema.Struct({
  ...Request.fields,
  id: Schema.optional(PermissionID),
  ruleset: Ruleset,
})
  .annotate({ identifier: "PermissionAskInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type AskInput = Schema.Schema.Type<typeof AskInput>

export const ReplyInput = Schema.Struct({
  requestID: PermissionID,
  ...reply,
})
  .annotate({ identifier: "PermissionReplyInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReplyInput = Schema.Schema.Type<typeof ReplyInput>

export interface Interface {
  readonly ask: (input: AskInput) => Effect.Effect<void, Error>
  readonly reply: (input: ReplyInput) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
}

interface State {
  pending: Map<PermissionID, PendingEntry>
  approved: Ruleset
}

export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  log.info("evaluate", { permission, pattern, ruleset: rulesets.flat() })
  return evalRule(permission, pattern, ...rulesets)
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/Permission") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        const row = Database.useProject((db) =>
          db.select().from(PermissionTable).where(eq(PermissionTable.project_id, ctx.project.id)).get(),
        )
        const state = {
          pending: new Map<PermissionID, PendingEntry>(),
          approved: row?.data ?? [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      let needsAsk = false

      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, approved)
        log.info("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
          return yield* Effect.fail(new DeniedError({
            ruleset: (ruleset ?? []).filter(
            (rule) => rule != null && Wildcard.match(request.permission, rule.permission),
          ),
          }))
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionID.ascending()
      const info = Schema.decodeUnknownSync(Request)({
        id,
        ...request,
      })
      log.info("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
      pending.set(id, { info, deferred })
      yield* bus.publish(Event.Asked, info)
      const awaitReply =
        info.permission === "plan_confirm"
          ? Deferred.await(deferred).pipe(
              Effect.timeout(PLAN_CONFIRM_TIMEOUT),
              Effect.catchTag("TimeoutError", () =>
                Effect.gen(function* () {
                  yield* bus.publish(Event.Replied, {
                    sessionID: info.sessionID,
                    requestID: info.id,
                    reply: "reject",
                  })
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
                  return yield* Effect.fail(new RejectedError())
                }),
              ),
            )
          : Deferred.await(deferred).pipe(
              Effect.timeout(PERMISSION_ASK_TIMEOUT),
              Effect.catchTag("TimeoutError", () =>
                Effect.gen(function* () {
                  yield* bus.publish(Event.Replied, {
                    sessionID: info.sessionID,
                    requestID: info.id,
                    reply: "reject",
                  })
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
                  return yield* Effect.fail(new RejectedError())
                }),
              ),
            )
      return yield* Effect.ensuring(
        awaitReply,
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return

      pending.delete(input.requestID)
      yield* bus.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
        rememberRejectedPlan(existing.info, input.message)
        yield* Deferred.fail(
          existing.deferred,
          input.message ? new CorrectedError({ feedback: input.message }) : new RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* bus.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      // Mirror an `external_directory` approval into the instance allow-list.
      //
      // `approved` above only exists on the TS side. The Rust run-loop enforces
      // its own `SecurityPolicy::check_path_access`, which knows nothing about
      // it — so without this the user would grant access to /project-B, and the
      // very next Rust-side read/write would still be refused.
      //
      // `allowedPaths` is that sync channel: it is populated *as a consequence
      // of* a user approval, never configured up-front. `postRunLoop` ships it
      // to Rust as `allowed_paths` on the next turn, keeping both enforcement
      // points on the same view of what the user actually allowed.
      if (existing.info.permission === "external_directory") {
        // Resolve the context via InstanceRef rather than the ALS: `reply`
        // is driven by an HTTP handler, not the tool's async context.
        const ins = yield* InstanceState.context
        for (const pattern of existing.info.always) {
          const dir = directoryOfPattern(pattern)
          if (dir) Instance.addAllowedPath(dir, ins)
        }
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* bus.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

/**
 * Recover the directory an `external_directory` pattern was built from.
 *
 * Both producers (`tool/external-directory.ts` and the bash pre-exec scan in
 * `tool/bash.ts`) construct their pattern as `path.join(dir, "*")`, so the
 * inverse is simply stripping the trailing `*` segment. Anything that does not
 * have that exact shape is ignored rather than guessed at — a wrong guess here
 * would silently widen the sandbox.
 */
function directoryOfPattern(pattern: string): string | undefined {
  const normalized = pattern.replaceAll("\\", "/")
  if (!normalized.endsWith("/*")) return undefined
  const dir = normalized.slice(0, -2)
  if (!dir || dir.includes("*")) return undefined
  return dir
}

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermission.Info) {
  // Sort top-level keys so wildcard permissions (`*`, `mcp_*`) come before
  // specific ones. Combined with `findLast` in evaluate(), this gives the
  // intuitive semantic "specific tool rules override the `*` fallback"
  // regardless of the user's JSON key order. Sub-pattern order inside a
  // single permission key is preserved — only top-level keys are sorted.
  const entries = Object.entries(permission).sort(([a], [b]) => {
    const aWild = a.includes("*")
    const bWild = b.includes("*")
    return aWild === bWild ? 0 : aWild ? -1 : 1
  })
  const ruleset: Ruleset = []
  for (const [key, value] of entries) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: Ruleset[]): Ruleset {
  // Drop any `undefined`/non-object entries so a merged ruleset is always
  // safe to traverse (see evaluate()). Does not affect legitimate rules.
  return rulesets.flat().filter((rule) => rule != null && typeof rule === "object")
}

const EDIT_TOOLS = ["edit", "write", "apply_patch"]

export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
  // Normalize: a caller may pass `undefined` directly (e.g. an agent missing
  // the `permission` field, as in `system.ts:305` / `debug/agent.ts:90`).
  // Without this, `ruleset.findLast` throws "undefined is not an object" —
  // the same class of crash as evaluate(). Does not affect legitimate rules.
  const rules = ruleset ?? []
  const result = new Set<string>()
  for (const tool of tools) {
    const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool
    const rule = rules.findLast((rule) => rule != null && Wildcard.match(permission, rule.permission))
    if (!rule) continue
    if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
  }
  return result
}

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Permission from "."
