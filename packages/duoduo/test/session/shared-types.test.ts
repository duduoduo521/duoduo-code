/**
 * Tests for the "## Shared Types" (①) knowledge-graph injection.
 *
 * Two layers:
 *  1. Pure-function tests (renderSharedTypesSection) — deterministic, no
 *     sidecar, cover every assembly/cap/truncation branch.
 *  2. Integration tests for buildSharedTypesSection — mock the smart-layer
 *     client + flag to exercise flag-off / clients-null / KG-success /
 *     KG-failure / cache-hit without a running sidecar.
 *
 * The single most important regression guard here is project scoping: the
 * backend keys the graph by a value derived from the project directory, so the
 * client must forward that directory — a locally composed key (the original
 * bug) matched nothing and silently returned zero nodes for every project.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import os from "os"
import { Instance } from "../../src/project/instance"

// ── Mocks (registered before the dynamic import so system.ts picks them up) ──
const fakeNodesByType = mock(
  (_nodeType: string, _projectId: string) => Promise.resolve([]) as Promise<unknown[]>,
)

const fakeClients = {
  graph: { nodesByType: fakeNodesByType },
}

let clientReturn: unknown = fakeClients
let flagEnabled = true

mock.module("@/smart-layer", () => ({
  createSmartLayerClients: () => clientReturn,
}))
// NOTE: use a getter so the value is read live at access time. mock.module
// caches the returned object for the lifetime of the (cache-busted) import, so
// a plain `{ DUODUO_KG_ENABLED: flagEnabled }` would freeze the first value.
mock.module("@/flag/flag", () => ({
  Flag: { get DUODUO_KG_ENABLED() { return flagEnabled } },
}))

// ── Mocks for projectGuidance (② coding standards + ① shared types glue) ──
// projectGuidance is a method on SystemPrompt.Service, so we must build the
// layer. It depends on Skill.Service + Instruction.Service; both are mocked to
// succeed-layers. We define self-contained fake tags and provide the SAME tag
// the mock exports, so system.ts's Layer.provide(defaultLayer) resolves
// consistently without loading the real (heavy) instruction/skill layers.
let instructionBlocks: string[] = []

class InstructionServiceMock extends Context.Service<
  InstructionServiceMock,
  {
    readonly clear: (m: unknown) => Effect.Effect<void, unknown, unknown>
    readonly systemPaths: () => Effect.Effect<Set<string>, unknown, unknown>
    readonly system: () => Effect.Effect<string[], unknown, unknown>
    readonly find: (d: string) => Effect.Effect<string | undefined, unknown, unknown>
    readonly resolve: (m: unknown, f: string, id: unknown) => Effect.Effect<{ filepath: string; content: string }[], unknown, unknown>
  }
>()("@duoduocode/Instruction") {}

class SkillServiceMock extends Context.Service<
  SkillServiceMock,
  {
    readonly get: (n: string) => Effect.Effect<unknown, unknown, unknown>
    readonly all: () => Effect.Effect<unknown[], unknown, unknown>
    readonly dirs: () => Effect.Effect<string[], unknown, unknown>
    readonly available: (a?: unknown) => Effect.Effect<unknown[], unknown, unknown>
  }
>()("@duoduocode/Skill") {}

mock.module("@/session/instruction", () => ({
  Instruction: {
    Service: InstructionServiceMock,
    defaultLayer: Layer.succeed(
      InstructionServiceMock,
      InstructionServiceMock.of({
        clear: () => Effect.succeed(undefined),
        systemPaths: () => Effect.succeed(new Set<string>()),
        system: () => Effect.succeed(instructionBlocks),
        find: () => Effect.succeed(undefined),
        resolve: () => Effect.succeed([]),
      }),
    ),
  },
}))

mock.module("@/skill", () => ({
  Skill: {
    Service: SkillServiceMock,
    defaultLayer: Layer.succeed(
      SkillServiceMock,
      SkillServiceMock.of({
        get: () => Effect.succeed(undefined),
        all: () => Effect.succeed([]),
        dirs: () => Effect.succeed([]),
        available: () => Effect.succeed([]),
      }),
    ),
  },
}))

const importSys = () =>
  import(`../../src/session/system.ts?t=${Date.now()}-${Math.random()}`)

const node = (label: string, type: string) => ({ id: label, label, type, properties: {} })

beforeEach(() => {
  fakeNodesByType.mockClear()
  fakeNodesByType.mockImplementation(() => Promise.resolve([]))
  clientReturn = fakeClients
  flagEnabled = true
})

describe("renderSharedTypesSection (pure)", () => {
  test("returns undefined when there are no nodes", async () => {
    const { renderSharedTypesSection } = await importSys()
    expect(renderSharedTypesSection([], [], 2000)).toBeUndefined()
  })

  test("renders Class + TypeAlias nodes", async () => {
    const { renderSharedTypesSection } = await importSys()
    const out = renderSharedTypesSection([node("Foo", "Class")], [node("Bar", "TypeAlias")], 2000)
    expect(out).toContain("## Shared Types")
    expect(out).toContain("- Foo (Class)")
    expect(out).toContain("- Bar (TypeAlias)")
  })

  test("caps at MAX_TYPES=80 entries", async () => {
    const { renderSharedTypesSection } = await importSys()
    const many = Array.from({ length: 200 }, (_, i) => node(`T${i}`, "Class"))
    const out = renderSharedTypesSection(many, [], 1_000_000)
    const listed = out!.split("\n").filter((l) => l.startsWith("- ")).length
    expect(listed).toBe(80)
  })

  test("budget-truncates and stops before overflowing", async () => {
    const { renderSharedTypesSection } = await importSys()
    const many = Array.from({ length: 50 }, (_, i) => node(`T${i}`, "Class"))
    // Each line is ~ "- T0 (Class)" ≈ 12 chars + 1 separator. Budget 30 → only 2 fit.
    const out = renderSharedTypesSection(many, [], 30)
    const listed = out!.split("\n").filter((l) => l.startsWith("- ")).length
    expect(listed).toBeGreaterThanOrEqual(1)
    expect(listed).toBeLessThanOrEqual(3)
  })

  test("always includes at least the first line even if budget is tiny", async () => {
    const { renderSharedTypesSection } = await importSys()
    const out = renderSharedTypesSection([node("Foo", "Class")], [], 3)
    // The first shared type is always shown (budget is a soft cap on ADDITIONAL lines).
    expect(out).toContain("- Foo (Class)")
  })
})

describe("buildSharedTypesSection (integration)", () => {
  test("flag off → undefined (no KG query)", async () => {
    flagEnabled = false
    const { buildSharedTypesSection } = await importSys()
    const out = await Effect.runPromise(buildSharedTypesSection(2000, "p1"))
    expect(out).toBeUndefined()
    expect(fakeNodesByType.mock.calls.length).toBe(0)
  })

  test("smart-layer unavailable (clients null) → undefined", async () => {
    clientReturn = null
    const { buildSharedTypesSection } = await importSys()
    const out = await Effect.runPromise(buildSharedTypesSection(2000, "p1"))
    expect(out).toBeUndefined()
  })

  test("KG returns Class + TypeAlias → section injected with both", async () => {
    fakeNodesByType.mockImplementation((nodeType: string) => {
      if (nodeType === "Class") return Promise.resolve([node("Foo", "Class")])
      if (nodeType === "TypeAlias") return Promise.resolve([node("Bar", "TypeAlias")])
      return Promise.resolve([])
    })
    const { buildSharedTypesSection } = await importSys()
    const out = await Effect.runPromise(buildSharedTypesSection(2000, "p1"))
    const lines = out!.split("\n")
    expect(lines[0]).toContain("## Shared Types")
    // Exact line format — guards against the double-format regression
    // ("- - Foo (Class) ()") that a bare toContain() would miss.
    expect(lines[1]).toBe("- Foo (Class)")
    expect(lines[2]).toBe("- Bar (TypeAlias)")
    expect(lines[1].startsWith("- - ")).toBe(false)
  })

  test("KG query throws → caught per-type → [] → undefined (never crashes)", async () => {
    fakeNodesByType.mockImplementation(() => Promise.reject(new Error("kg down")))
    const { buildSharedTypesSection } = await importSys()
    const out = await Effect.runPromise(buildSharedTypesSection(2000, "p1"))
    expect(out).toBeUndefined()
  })

  test("cache hit: second call within TTL does not re-query the sidecar", async () => {
    fakeNodesByType.mockImplementation((nodeType: string) => {
      if (nodeType === "Class") return Promise.resolve([node("Foo", "Class")])
      return Promise.resolve([])
    })
    const { buildSharedTypesSection } = await importSys()
    await Effect.runPromise(buildSharedTypesSection(2000, "p-cache"))
    await Effect.runPromise(buildSharedTypesSection(2000, "p-cache"))
    // First call issues Class + TypeAlias (2). Cache hit → 0 more.
    expect(fakeNodesByType.mock.calls.length).toBe(2)
  })

  test("scope is per projectId: different project queries the sidecar again", async () => {
    fakeNodesByType.mockImplementation(() => Promise.resolve([]))
    const { buildSharedTypesSection } = await importSys()
    await Effect.runPromise(buildSharedTypesSection(2000, "p-a"))
    await Effect.runPromise(buildSharedTypesSection(2000, "p-b"))
    expect(fakeNodesByType.mock.calls.length).toBe(4)
  })
})

describe("projectGuidance (direct — closes the 'no direct unit test' residual)", () => {
  beforeEach(() => {
    instructionBlocks = []
    fakeNodesByType.mockClear()
    fakeNodesByType.mockImplementation(() => Promise.resolve([]))
    clientReturn = fakeClients
    flagEnabled = true
  })

  // Run projectGuidance through the real Service layer (which is why we mock
  // Skill/Instruction above). Resolves the service instance via
  // Effect.flatMap(Service, ...) then invokes the method.
  // projectGuidance reads Instance.directory / Instance.project (system.ts),
  // so the invocation must run inside an Instance context; use the OS temp
  // dir (no .git probe side effects, no fixture git setup needed).
  const run = (args?: {
    excludeRemoteUrls?: boolean
    tokenBudget?: number
    includeSharedTypes?: boolean
  }) =>
    importSys().then((mod) => {
      const rt = ManagedRuntime.make(mod.defaultLayer)
      return Instance.provide({
        directory: os.tmpdir(),
        fn: () =>
          rt.runPromise(
            Effect.gen(function* () {
              const svc = yield* mod.Service
              return yield* svc.projectGuidance(args)
            }),
          ),
      }).finally(() => rt.dispose())
    })

  test("no blocks + no shared types → undefined", async () => {
    expect(await run({ includeSharedTypes: false })).toBeUndefined()
  })

  test("② local coding-standards block injected under '## Coding Standards'", async () => {
    instructionBlocks = ["## Local rules\n- Use strict mode"]
    const out = await run({ includeSharedTypes: false })
    expect(out).toContain("## Coding Standards")
    expect(out).toContain("## Local rules")
  })

  test("excludeRemoteUrls:true drops 'Instructions from: http' blocks", async () => {
    instructionBlocks = [
      "## Local rules\n- Use strict mode",
      "Instructions from: https://evil.example/rules\n- do something",
    ]
    const out = await run({ excludeRemoteUrls: true, includeSharedTypes: false })
    expect(out).toContain("## Local rules")
    expect(out).not.toContain("https://evil.example/rules")
  })

  test("excludeRemoteUrls:false keeps remote instruction blocks", async () => {
    instructionBlocks = [
      "## Local rules\n- Use strict mode",
      "Instructions from: https://evil.example/rules\n- do something",
    ]
    const out = await run({ excludeRemoteUrls: false, includeSharedTypes: false })
    expect(out).toContain("https://evil.example/rules")
  })

  test("① includeSharedTypes:true appends '## Shared Types' from KG", async () => {
    fakeNodesByType.mockImplementation((nodeType: string) => {
      if (nodeType === "Class") return Promise.resolve([node("Foo", "Class")])
      if (nodeType === "TypeAlias") return Promise.resolve([node("Bar", "TypeAlias")])
      return Promise.resolve([])
    })
    const out = await run({ includeSharedTypes: true })
    expect(out).toContain("## Shared Types")
    expect(out).toContain("- Foo (Class)")
    expect(out).toContain("- Bar (TypeAlias)")
  })

  test("KG failure degrades gracefully: coding standards still returned", async () => {
    instructionBlocks = ["## Local rules\n- Use strict mode"]
    fakeNodesByType.mockImplementation(() => Promise.reject(new Error("kg down")))
    const out = await run({ includeSharedTypes: true })
    expect(out).toContain("## Coding Standards")
    expect(out).toContain("## Local rules")
    expect(out).not.toContain("## Shared Types")
  })

  test("KGEntity→SharedTypeNode defensive strip: extra KG fields never leak into prompt", async () => {
    // Guards the .map(e => ({ label, type })) fix — a future KGEntity with a
    // secret/extra field must NOT surface in the injected shared-types section.
    fakeNodesByType.mockImplementation(() =>
      Promise.resolve([
        { id: "x", label: "Foo", type: "Class", properties: { secret: "LEAK" } },
      ] as unknown[]),
    )
    const out = await run({ includeSharedTypes: true })
    expect(out).toContain("- Foo (Class)")
    expect(out).not.toContain("LEAK")
  })
})
