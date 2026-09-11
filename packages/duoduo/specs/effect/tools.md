# Tool migration

Practical reference for the current tool-migration state in `packages/duoduo`.

## Status

`Tool.Def.execute` and `Tool.Info.init` already return `Effect` on this branch, and the built-in tool surface is now largely on the target shape.

The current exported tools in `src/tool` all use `Tool.define(...)` with Effect-based initialization, and nearly all of them already build their tool body with `Effect.gen(...)` and `Effect.fn(...)`.

So the remaining work is no longer "convert tools to Effect at all". The remaining work is mostly:

1. remove Promise and raw platform bridges inside individual tool bodies
2. swap tool internals to Effect-native services like `AppFileSystem`, `HttpClient`, and `ChildProcessSpawner`
3. keep tests and callers aligned with `yield* info.init()` and real service graphs

## Current shape

`Tool.define(...)` is already the Effect-native helper here.

- `init` is an `Effect`
- `info.init()` returns an `Effect`
- `execute(...)` returns an `Effect`

That means a tool does not need a separate `Tool.defineEffect(...)` helper to count as migrated. A tool is effectively migrated when its init and execute path stay Effect-native, even if some internals still bridge to Promise-based or raw APIs.

## Tests

Tool tests should use the existing Effect helpers in `packages/duoduo/test/lib/effect.ts`:

- Use `testEffect(...)` / `it.live(...)` instead of creating fake local wrappers around effectful tools.
- Yield the real tool export, then initialize it: `const info = yield* ReadTool`, `const tool = yield* info.init()`.
- Run tests inside a real instance with `provideTmpdirInstance(...)` or `provideInstance(tmpdirScoped(...))` so instance-scoped services resolve exactly as they do in production.

This keeps tool tests aligned with the production service graph and makes follow-up cleanup mostly mechanical.

## Exported tools

These exported tool definitions currently use `Tool.define(...)` in `src/tool`:

- [x] `apply_patch.ts`
- [x] `bash.ts`
- [x] `edit.ts`
- [x] `glob.ts`
- [x] `grep.ts`
- [x] `invalid.ts`
- [x] `lsp.ts`
- [x] `plan.ts`
- [x] `question.ts`
- [x] `read.ts`
- [x] `skill.ts`
- [x] `task.ts`
- [x] `todo.ts`
- [x] `webfetch.ts`
- [x] `write.ts`

Notes:

- There is no current `ls.ts` tool file on this branch.
- `truncate.ts` is an Effect service used by tools, not a tool definition itself.
- `mcp-exa.ts`, `external-directory.ts`, and `schema.ts` are support modules, not standalone tool definitions.
- `codesearch.ts` / `websearch.ts` / `mcp-exa.ts` were **removed**: web/codesearch previously depended on `EXA_API_KEY` (Exa MCP), which is unusable in packaged desktop builds. LLM now performs web search via provider-native natural-language capability. See Layer A (Rust tool schema single-source) for the canonical tool list.

## Follow-up cleanup

Most exported tools are already on the intended Effect-native shape. The remaining cleanup is narrower than the old checklist implied.

Current spot cleanups worth tracking:

- [ ] `read.ts` — still bridges to Node stream / `readline` helpers and Promise-based binary detection
- [ ] `bash.ts` — already uses Effect child-process primitives; only keep tracking shell-specific platform bridges and parser/loading details as they come up
- [ ] `webfetch.ts` — already uses `HttpClient`; remaining work is limited to smaller boundary helpers like HTML text extraction
- [ ] `file/ripgrep.ts` — adjacent to tool migration; still has raw fs/process usage that affects `grep.ts` and file-search routes
- [ ] `patch/index.ts` — adjacent to tool migration; still has raw fs usage behind patch application

Notable items that are already effectively on the target path and do not need separate migration bullets right now:

- `apply_patch.ts`
- `grep.ts`
- `write.ts`
- `edit.ts`

## Filesystem notes

Current raw fs users that still appear relevant here:

- `tool/read.ts` — `fs.createReadStream`, `readline`
- `file/ripgrep.ts` — `fs/promises`
- `patch/index.ts` — `fs`, `fs/promises`

## Layer A: Rust tool schema single-source (strategy B2)

The LLM contract for every built-in tool has a single source of truth in
**Rust** (`crates/agent-executor/src/agentic_loop.rs`), exposed as `xxx_tool()`
factory functions returning `duo_types::ToolDefinition`. TypeScript keeps a
mirror only so that `Tool.Def.execute`'s argument type stays type-safe — it is
**not** the contract source.

### Canonical schema owners (Rust)

Listed tools (advertised to the LLM) already had `xxx_tool()` factories. The
following **dispatch-only** tools gained Rust factories as the canonical schema
baseline (their `listed_when` is `listed_never`, and their `meta` in
`dispatch.rs` points at the same factory):

- `glob_tool()` — mirrors `src/tool/glob.ts` + `glob.txt`
- `write_tool()` — mirrors `src/tool/write.ts` + `write.txt`
- `task_tool()` — mirrors `src/tool/task.ts` + `task.txt`
- `apply_patch_tool()` — mirrors `src/tool/apply_patch.ts` + `apply_patch.txt`
  (executed on the TS side; Rust holds the schema baseline only — `#[allow(dead_code)]`)
- `proceed_to_investigate_tool()` / `proceed_to_plan_tool()` /
  `proceed_to_execute_tool()` / `proceed_to_verify_tool()` — mirror
  `src/tool/proceed_to.ts` phase descriptions

### Sync rule

Keep the two sides byte-identical for the LLM contract:

- The `description` string in each Rust `xxx_tool()` MUST match the TS `.txt`
  body + zod `describe(...)` text verbatim.
- `required` field lists MUST match the zod schema's `.required([...])`.
- When editing a tool's parameters or description, edit **both** the Rust
  factory and the TS `*.ts`/`*.txt` so the contract cannot drift.

### Why B2 (not B1)

B1 would have downgraded each TS `execute` from a precise zod-inferred type to
`Record<string, unknown>` (introducing `any`), losing compile-time argument
safety and violating the no-`any` rule. B2 keeps the precise zod type on the TS
side for `execute` while Rust owns the published contract — no type-safety
regression, lower risk.
