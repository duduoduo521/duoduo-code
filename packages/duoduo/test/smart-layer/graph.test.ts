/**
 * Tests for `GraphClient.nodesByType` — specifically the project scoping added
 * alongside ① (shared-types injection).
 *
 * The graph is keyed by a value the backend derives from the project
 * *directory*, so the client forwards the directory and never composes a key
 * of its own. Passing it is what makes ① return any nodes at all; omitting it
 * means "no filter", so these tests pin both directions.
 */
import { describe, test, expect } from "bun:test"
import { GraphClient } from "../../src/smart-layer/graph"

const makeClient = (capture: { body?: unknown; path?: string }) => ({
  post: (path: string, body: unknown) => {
    capture.path = path
    capture.body = body
    return Promise.resolve([])
  },
}) as any

describe("GraphClient.nodesByType", () => {
  test("forwards the project directory into the query payload", async () => {
    const captured: { body?: any; path?: string } = {}
    const g = new GraphClient(makeClient(captured))
    const out = await g.nodesByType("Class", "/work/proj")
    expect(out).toEqual([])
    expect(captured.path).toBe("/graph/query")
    expect(captured.body.queryType).toBe("nodes_by_type")
    expect(captured.body.nodeType).toBe("Class")
    expect(captured.body.projectPath).toBe("/work/proj")
    expect(captured.body.projectId).toBeUndefined()
  })

  test("omits the scope when not provided (no cross-project leakage)", async () => {
    const captured: { body?: any } = {}
    const g = new GraphClient(makeClient(captured))
    await g.nodesByType("TypeAlias")
    expect(captured.body.nodeType).toBe("TypeAlias")
    expect(captured.body.projectPath).toBeUndefined()
  })

  test("returns the entities the sidecar reports", async () => {
    const entities = [
      { id: "1", label: "Foo", type: "Class" },
      { id: "2", label: "Bar", type: "Class" },
    ]
    const client = {
      post: (_p: string, _b: unknown) => Promise.resolve(entities),
    } as any
    const g = new GraphClient(client)
    const out = await g.nodesByType("Class", "/work/proj")
    expect(out).toHaveLength(2)
    expect(out[0].label).toBe("Foo")
  })
})
