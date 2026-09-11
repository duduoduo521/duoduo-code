/**
 * Tests for `buildSubTasks` — the ③ contract-planner wiring that turns a
 * planner's `decompose` tool-call input into concrete `SubTaskRequest[]`.
 *
 * This is the integration glue between the pure `contract.ts` builders
 * (`buildFileContract` / `renderFileContract`, covered in contract.test.ts) and
 * the Rust `SubTaskRequest` wire shape. The key behaviours guarded here:
 *   - a planned sub-task with `targetFile` → contract attached as
 *     `target_file` + `interface_contract` (snake_case) and rendered into
 *     `system_prompt` (M2).
 *   - KG outage / no-class-node → `buildFileContract` returns undefined → the
 *     sub-task still runs, unconstrained (R6.1, zero regression).
 *   - missing `targetFile` → no contract fields.
 *   - invalid entries (no id / no task) are dropped.
 *   - `mode: "explore"` is preserved.
 *
 * `buildFileContract`/`renderFileContract` are mocked (no sidecar needed) so the
 * test is deterministic and fast.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test"
import { Effect } from "effect"

const fakeContract = {
  extends: undefined,
  properties: { id: "string" },
  methods: {
    save: { params: [], return_type: "void", description: undefined, side_effects: [] },
  },
}

const renderMarker = (tf: string) => `## File Contract (${tf}) [mocked]`

// Reset the contract mock to "KG returns a contract" before every test so the
// undefined-returning override in one case does not leak into the next.
beforeEach(() => {
  mock.module("@/smart-layer/contract", () => ({
    buildFileContract: mock(() => Effect.succeed(fakeContract as any)),
    renderFileContract: mock((tf: string) => renderMarker(tf)),
  }))
})

const importMod = () => import(`../../src/smart-layer/decompose.ts?t=${Date.now()}-${Math.random()}`)

const run = (input: any[], envLines: string[] = ["ENV"], codingStandards?: string) =>
  importMod().then((mod) => Effect.runPromise(mod.buildSubTasks(input, envLines, codingStandards)))

describe("buildSubTasks — ③ targetFile → contract wiring", () => {
  test("targetFile present → target_file + interface_contract + rendered prompt", async () => {
    const out = await run([
      { id: "s1", task: "implement User model", mode: "codegen", targetFile: "src/User.ts" },
    ])
    expect(out).toHaveLength(1)
    const s = out[0]
    expect(s.id).toBe("s1")
    expect(s.target_file).toBe("src/User.ts")
    expect(s.interface_contract).toEqual(fakeContract)
    expect(s.system_prompt).toContain(renderMarker("src/User.ts"))
    // env + coding-standards + contract + instruction lines all joined.
    expect(s.system_prompt).toContain("ENV")
  })

  test("targetFile present but buildFileContract returns undefined → no contract (R6.1)", async () => {
    mock.module("@/smart-layer/contract", () => ({
      buildFileContract: mock(() => Effect.succeed(undefined)),
      renderFileContract: mock((tf: string) => renderMarker(tf)),
    }))
    const out = await run([
      { id: "s1", task: "implement User model", mode: "codegen", targetFile: "src/User.ts" },
    ])
    expect(out[0].target_file).toBeUndefined()
    expect(out[0].interface_contract).toBeUndefined()
    expect(out[0].system_prompt).not.toContain("## File Contract")
  })

  test("no targetFile → no contract fields", async () => {
    const out = await run([{ id: "s1", task: "do stuff", mode: "explore" }])
    expect(out[0].target_file).toBeUndefined()
    expect(out[0].interface_contract).toBeUndefined()
  })

  test("empty/whitespace targetFile treated as no contract", async () => {
    const out = await run([
      { id: "s1", task: "do stuff", targetFile: "   " },
      { id: "s2", task: "other", targetFile: "" },
    ])
    for (const s of out) {
      expect(s.target_file).toBeUndefined()
      expect(s.interface_contract).toBeUndefined()
    }
  })

  test("invalid entries (no id / no task) are dropped", async () => {
    const out = await run([
      { id: "s1", task: "valid" },
      { task: "no id" },
      { id: "s2" },
      null,
    ])
    expect(out.map((s) => s.id)).toEqual(["s1"])
  })

  test("mode: explore is preserved, unspecified defaults to codegen", async () => {
    const out = await run([
      { id: "e", task: "read", mode: "explore" },
      { id: "c", task: "write" },
    ])
    expect(out.find((s) => s.id === "e")!.mode).toBe("explore")
    expect(out.find((s) => s.id === "c")!.mode).toBe("codegen")
  })

  test("multiple sub-tasks: contract only bound where targetFile is set", async () => {
    const out = await run([
      { id: "a", task: "impl A", targetFile: "a.ts" },
      { id: "b", task: "impl B" },
    ])
    expect(out.find((s) => s.id === "a")!.target_file).toBe("a.ts")
    expect(out.find((s) => s.id === "b")!.target_file).toBeUndefined()
  })
})
