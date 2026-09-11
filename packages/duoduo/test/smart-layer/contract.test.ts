/**
 * Tests for the ③ contract planner (M1 `contract.ts`).
 *
 * Two layers, mirroring `shared-types.test.ts`:
 *  1. Pure-function tests (`renderFileContract`) — deterministic, no sidecar.
 *  2. Integration tests for `buildFileContract` — mock the smart-layer client +
 *     flag + instance to exercise flag-off / clients-null / no-class-node /
 *     file-mismatch / KG-success / KG-failure / neighbors-failure without a
 *     running sidecar.
 *
 * The single most important regression guard here is that `buildFileContract`
 * degrades to `undefined` on EVERY KG failure path (flag off, clients null,
 * no class node, KG timeout) — it must never crash the decompose request
 * (R6.1, zero regression). The second guard is `fileMatches`: a relative
 * planner target_path must still bind to an absolute KG `properties.file`.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test"
import { Effect } from "effect"
import type { InterfaceContract } from "@/smart-layer/types"
import type { SubTaskRequest } from "../../src/smart-layer/agent"

// ── Mocks (registered before the dynamic import so contract.ts picks them up) ──
const fakeNodesByType = mock(
  (_nodeType: string, _projectId: string) => Promise.resolve([]) as Promise<unknown[]>,
)
const fakeNeighbors = mock((_nodeId: string) => Promise.resolve([]) as Promise<unknown[]>)
const fakeNeighborsWithEdges = mock((_nodeId: string) =>
  Promise.resolve({ nodes: [] as unknown[] }),
)

const fakeClients = {
  graph: {
    nodesByType: fakeNodesByType,
    neighbors: fakeNeighbors,
    neighborsWithEdges: fakeNeighborsWithEdges,
  },
}

let clientReturn: unknown = fakeClients
let flagEnabled = true

mock.module("@/smart-layer", () => ({
  createSmartLayerClients: () => clientReturn,
}))
// getter so the value is read live at access time (mock.module caches the object).
mock.module("@/flag/flag", () => ({
  Flag: { get DUODUO_KG_ENABLED() { return flagEnabled } },
}))
// resolveKgProjectId reads Instance.directory + Instance.project.id.
// NOTE: Bun's `mock.module` factory takes NO arguments (it does not receive an
// `actual` resolver), so we cannot spread the real module here. `contract.ts`
// only consumes `Instance.directory` and `Instance.project.id`, so a minimal
// `Instance` mock is sufficient and keeps the test free of real-module load
// ordering issues.
mock.module("@/project/instance", () => ({
  Instance: { directory: "/tmp/proj", project: { id: "pid123" } },
}))

const importContract = () =>
  import(`../../src/smart-layer/contract.ts?t=${Date.now()}-${Math.random()}`)

const node = (
  id: string,
  label: string,
  type: string,
  properties: Record<string, unknown> = {},
) => ({ id, label, type, properties })

beforeEach(() => {
  fakeNodesByType.mockClear()
  fakeNodesByType.mockImplementation(() => Promise.resolve([]))
  fakeNeighbors.mockClear()
  fakeNeighbors.mockImplementation(() => Promise.resolve([]))
  fakeNeighborsWithEdges.mockClear()
  fakeNeighborsWithEdges.mockImplementation(() => Promise.resolve({ nodes: [] as unknown[] }))
  clientReturn = fakeClients
  flagEnabled = true
})

describe("renderFileContract (pure)", () => {
  test("renders title, disclaimer, extends, methods, properties", async () => {
    const { renderFileContract } = await importContract()
    const contract: InterfaceContract = {
      extends: "Model",
      properties: { name: "" },
      methods: { save: {} },
    }
    const out = renderFileContract("app/Models/Post.ts", contract)
    expect(out).toContain("## File Contract (app/Models/Post.ts)")
    expect(out).toContain("knowledge-graph snapshot")
    expect(out).toContain("source of truth")
    expect(out).toContain("Extends: Model")
    expect(out).toContain("Methods (must be implemented): save")
    expect(out).toContain("Properties: name")
  })

  test("omits the Extends line when there is no parent", async () => {
    const { renderFileContract } = await importContract()
    const out = renderFileContract("f.ts", { properties: {}, methods: {} })
    expect(out).not.toContain("Extends:")
  })
})

describe("buildFileContract (integration)", () => {
  test("flag off → undefined, no KG query", async () => {
    flagEnabled = false
    const { buildFileContract } = await importContract()
    const out = await Effect.runPromise(buildFileContract("app/Models/Post.ts"))
    expect(out).toBeUndefined()
    expect(fakeNodesByType.mock.calls.length).toBe(0)
  })

  test("smart-layer unavailable (clients null) → undefined", async () => {
    clientReturn = null
    const { buildFileContract } = await importContract()
    const out = await Effect.runPromise(buildFileContract("app/Models/Post.ts"))
    expect(out).toBeUndefined()
  })

  test("no Class node for the file → undefined", async () => {
    fakeNodesByType.mockImplementation((nodeType: string) =>
      nodeType === "Class" ? Promise.resolve([]) : Promise.resolve([]),
    )
    const { buildFileContract } = await importContract()
    const out = await Effect.runPromise(buildFileContract("app/Models/Post.ts"))
    expect(out).toBeUndefined()
  })

  // C: 非 class 文件（仅有 Function/Method 根节点）也应生成 contract（KG 辅助）
  test("C: builds contract from Function/Method roots when no Class present", async () => {
    fakeNodesByType.mockImplementation((nodeType: string) => {
      if (nodeType === "Function")
        return Promise.resolve([node("fn1", "doThing", "Function", { file: "/proj/x/file.ts" })])
      if (nodeType === "Method")
        return Promise.resolve([node("m1", "helper", "Method", { file: "/proj/x/file.ts" })])
      return Promise.resolve([])
    })
    fakeNeighborsWithEdges.mockImplementation((id: string) => {
      if (id === "fn1")
        return Promise.resolve({
          nodes: [node("cf1", "Dep.out", "Class", { file: "/proj/x/other.ts" })],
        })
      return Promise.resolve({ nodes: [] as unknown[] })
    })
    const { buildFileContract } = await importContract()
    const out = await Effect.runPromise(buildFileContract("x/file.ts", "pid123"))
    expect(out).toBeDefined()
    expect(out!.related).toContain("out") // 跨文件 Function 依赖被收集
    expect(out!.related).not.toContain("helper") // 同文件 Method 不应计入跨文件
  })

  // A: BFS 2-hop —— 第二跳的跨文件邻居也应被收集
  test("A: BFS collects cross-file neighbors at depth 2", async () => {
    fakeNodesByType.mockImplementation((nodeType: string) =>
      nodeType === "Class"
        ? Promise.resolve([node("c1", "Foo", "Class", { file: "/proj/x/file.ts" })])
        : Promise.resolve([]),
    )
    fakeNeighborsWithEdges.mockImplementation((id: string) => {
      if (id === "c1")
        return Promise.resolve({
          nodes: [node("n1", "Bar.first", "Class", { file: "/proj/x/mid.ts" })],
        })
      if (id === "n1")
        return Promise.resolve({
          nodes: [node("n2", "Baz.deep", "Class", { file: "/proj/x/deep.ts" })],
        })
      return Promise.resolve({ nodes: [] as unknown[] })
    })
    const { buildFileContract } = await importContract()
    const out = await Effect.runPromise(buildFileContract("x/file.ts", "pid123"))
    expect(out!.related).toContain("first") // 第一跳
    expect(out!.related).toContain("deep") // 第二跳（BFS 多跳）
  })

  // B: 噪声降到极低 —— 无 file 属性的邻居必须丢弃
  test("B: drops neighbors without a file property (noise reduction)", async () => {
    fakeNodesByType.mockImplementation((nodeType: string) =>
      nodeType === "Class"
        ? Promise.resolve([node("c1", "Foo", "Class", { file: "/proj/x/file.ts" })])
        : Promise.resolve([]),
    )
    fakeNeighborsWithEdges.mockImplementation(() =>
      Promise.resolve({
        nodes: [
          node("n1", "NoFile.orphan", "Class", {}), // 无 file
          node("n2", "Same.local", "Class", { file: "/proj/x/file.ts" }), // 同文件
          node("n3", "Cross.remote", "Class", { file: "/proj/x/other.ts" }), // 跨文件
        ],
      }),
    )
    const { buildFileContract } = await importContract()
    const out = await Effect.runPromise(buildFileContract("x/file.ts", "pid123"))
    expect(out!.related).toContain("remote")
    expect(out!.related).not.toContain("orphan") // B: 无 file 丢弃
    expect(out!.related).not.toContain("local") // 同文件排除
  })

  test("Class node exists but properties.file does not match → undefined", async () => {
    fakeNodesByType.mockImplementation((nodeType: string) =>
      nodeType === "Class"
        ? Promise.resolve([node("c1", "Post", "Class", { file: "/proj/app/Other.ts" })])
        : Promise.resolve([]),
    )
    const { buildFileContract } = await importContract()
    const out = await Effect.runPromise(buildFileContract("app/Models/Post.ts"))
    expect(out).toBeUndefined()
  })

  test("Class node with matching file → contract built from neighbors", async () => {
    fakeNodesByType.mockImplementation((nodeType: string) =>
      nodeType === "Class"
        ? Promise.resolve([node("c1", "Post", "Class", { file: "/proj/app/Models/Post.ts" })])
        : Promise.resolve([]),
    )
    fakeNeighbors.mockImplementation(() =>
      Promise.resolve([
        node("m1", "Post.save", "Method", {}),
        node("m2", "Post.find", "Function", {}),
        node("p1", "Post.name", "Field", {}),
        node("p2", "Post.status", "Property", {}),
      ]),
    )
    const { buildFileContract } = await importContract()
    const out = await Effect.runPromise(buildFileContract("app/Models/Post.ts"))
    expect(out).toBeDefined()
    expect(out!.methods).toHaveProperty("save")
    expect(out!.methods).toHaveProperty("find")
    expect(out!.properties).toHaveProperty("name")
    expect(out!.properties).toHaveProperty("status")
  })

  test("relative planner target binds to absolute KG properties.file", async () => {
    // planner emits "app/Models/Post.ts" (relative); KG stores absolute path.
    // fileMatches must still bind them.
    fakeNodesByType.mockImplementation((nodeType: string) =>
      nodeType === "Class"
        ? Promise.resolve([node("c1", "Post", "Class", { file: "/proj/app/Models/Post.ts" })])
        : Promise.resolve([]),
    )
    fakeNeighbors.mockImplementation(() =>
      Promise.resolve([node("m1", "Post.save", "Method", {})]),
    )
    const { buildFileContract } = await importContract()
    const out = await Effect.runPromise(buildFileContract("app/Models/Post.ts"))
    expect(out).toBeDefined()
    expect(out!.methods).toHaveProperty("save")
  })

  test("KG nodesByType throws → undefined (degrades gracefully)", async () => {
    fakeNodesByType.mockImplementation(() => Promise.reject(new Error("kg down")))
    const { buildFileContract } = await importContract()
    const out = await Effect.runPromise(buildFileContract("app/Models/Post.ts"))
    expect(out).toBeUndefined()
  })

  test("neighbors throws → members empty but contract still returned", async () => {
    fakeNodesByType.mockImplementation((nodeType: string) =>
      nodeType === "Class"
        ? Promise.resolve([node("c1", "Post", "Class", { file: "/proj/app/Models/Post.ts" })])
        : Promise.resolve([]),
    )
    fakeNeighbors.mockImplementation(() => Promise.reject(new Error("neighbors down")))
    const { buildFileContract } = await importContract()
    const out = await Effect.runPromise(buildFileContract("app/Models/Post.ts"))
    // Class node exists ⇒ contract returned; members empty due to KG failure.
    expect(out).toBeDefined()
    expect(Object.keys(out!.methods).length).toBe(0)
    expect(Object.keys(out!.properties).length).toBe(0)
  })
})

describe("SubTaskRequest wire format (B1 → Rust)", () => {
  test("target_file / interface_contract serialize as snake_case", () => {
    // Guards the line-format contract with Rust's `SubTaskRequest`
    // (snake_case wire fields, no serde rename).
    const req: SubTaskRequest = {
      id: "t1",
      task_prompt: "do it",
      target_file: "src/a.ts",
      interface_contract: { properties: {}, methods: {} },
    }
    const json = JSON.stringify(req)
    expect(json).toContain("target_file")
    expect(json).toContain("interface_contract")
    expect(json).not.toContain("targetFile")
  })
})
