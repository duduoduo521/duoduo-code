import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/**
 * Cross-language tool-name contract test.
 *
 * The Rust dispatch table (`crates/agent-executor/src/tools/dispatch.rs`
 * `TOOL_REGISTRY`) and the TS tool registry (`src/tool/registry.ts` +
 * `src/tool/*.ts` `Tool.define` ids) are two views of the same surface.
 * They are NOT the same list by design:
 *
 *  - Rust dispatches by name; entries marked `listed_never` are still
 *    routable (the loop advertises them via other means).
 *  - TS-only tools (question / todowrite / lsp / plan_exit / blackboard_* /
 *    search_modifications / invalid / skill) are dispatched on the TS side
 *    or via HTTP and never reach the Rust dispatch table.
 *
 * What MUST stay true:
 *  1. every TS tool id is either a known Rust dispatch name or in the
 *     explicit TS-only allowlist below;
 *  2. the TS side still registers every tool it did when this contract was
 *     written (no silent removals);
 *  3. the webfetch alias stays "webfetch" (the Rust dispatch table only
 *     knows "webfetch"; registering it as "fetch" would make every web
 *     fetch dispatch into "unknown tool").
 */

const RUST_DISPATCH_NAMES: ReadonlySet<string> = new Set([
  // Snapshot of dispatch.rs TOOL_REGISTRY `names` entries (R6/6.2 contract).
  "read_file",
  "read",
  "list_dir",
  "grep",
  "bash",
  "webfetch",
  "clone_repo",
  "submit_code",
  "edit_file",
  "edit",
  "code_comment",
  "graph_query",
  "symbol_search",
  "recall_memory",
  "glob",
  "write",
  "write_file",
  "task",
  "load_skill",
  "proceed_to_investigate",
  "proceed_to_plan",
  "proceed_to_execute",
  "proceed_to_verify",
  "apply_patch",
])

const TS_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "question",
  "todowrite",
  "lsp",
  "plan_exit",
  "invalid",
  "skill",
  "search_modifications",
  "blackboard_read",
  "blackboard_write",
  "blackboard_find",
  "blackboard_submit_draft",
  "blackboard_submit_stable",
  "blackboard_annotate",
])

const KNOWN_TS_IDS: readonly string[] = [
  "apply_patch",
  "bash",
  "blackboard_read",
  "blackboard_write",
  "blackboard_find",
  "blackboard_submit_draft",
  "blackboard_submit_stable",
  "blackboard_annotate",
  "code_comment",
  "edit",
  "glob",
  "graph_query",
  "grep",
  "invalid",
  "lsp",
  "plan_exit",
  "question",
  "read",
  "recall_memory",
  "search_modifications",
  "skill",
  "symbol_search",
  "todowrite",
  "task",
  "webfetch",
  "write",
  "proceed_to_investigate",
  "proceed_to_plan",
  "proceed_to_execute",
  "proceed_to_verify",
]

// Ids defined via a variable (not a string literal at the Tool.define site).
const DYNAMIC_IDS: ReadonlyMap<string, string[]> = new Map([
  ["task.ts", ["task"]],
  [
    "proceed_to.ts",
    ["proceed_to_investigate", "proceed_to_plan", "proceed_to_execute", "proceed_to_verify"],
  ],
])

function scanToolIds(): Map<string, string> {
  const dir = path.join(import.meta.dir, "..", "..", "src", "tool")
  const ids = new Map<string, string>()
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
    const text = fs.readFileSync(path.join(dir, file), "utf-8")
    const matches = [...text.matchAll(/Tool\.define[^(]*\(\s*\n?\s*"([a-z_]+)"/g)]
    for (const m of matches) ids.set(m[1]!, file)
    if (DYNAMIC_IDS.has(file) && /Tool\.define\(/.test(text)) {
      for (const dynId of DYNAMIC_IDS.get(file)!) ids.set(dynId, file)
    }
  }
  return ids
}

describe("tool registry contract (Rust dispatch ↔ TS registry)", () => {
  const scanned = scanToolIds()

  test("scans a sane number of tool definitions", () => {
    expect(KNOWN_TS_IDS.length).toBeGreaterThanOrEqual(25)
    expect(scanned.size).toBe(KNOWN_TS_IDS.length)
  })

  test("every known TS tool id is still registered", () => {
    for (const id of KNOWN_TS_IDS) {
      // Deliberately a boolean check: an `?? "MISSING"` fallback would still
      // satisfy expect.any(String) and silently pass on missing entries.
      expect(`${id}: ${scanned.has(id)}`).toBe(`${id}: true`)
    }
  })

  test("every TS tool id is either a Rust dispatch name or an explicit TS-only tool", () => {
    for (const [id, file] of scanned) {
      expect({
        id,
        rustKnown: RUST_DISPATCH_NAMES.has(id),
        tsOnly: TS_ONLY_TOOLS.has(id),
        file,
      }).toEqual({
        id,
        rustKnown: expect.any(Boolean),
        tsOnly: expect.any(Boolean),
        file,
      })
      const ok = RUST_DISPATCH_NAMES.has(id) || TS_ONLY_TOOLS.has(id)
      expect(`dispatchable: ${id} (${file}) = ${ok}`).toBe(`dispatchable: ${id} (${file}) = true`)
    }
  })

  test("webfetch keeps its Rust-compatible name", () => {
    expect(scanned.has("webfetch")).toBe(true)
    expect(scanned.has("fetch")).toBe(false)
  })
})
