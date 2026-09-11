import { describe, expect, mock, test } from "bun:test"
import { Effect } from "effect"

// `writeCascadeValidationResult` builds its own clients via
// `createSmartLayerClients()`, so the factory is stubbed and the module under
// test is re-imported with a cache-busting query on every test.
// NOTE: Bun's `mock.module` factory takes NO arguments (there is no `actual`
// resolver), so the real module cannot be spread here. `cascade-blackboard.ts`
// only consumes `createSmartLayerClients`, so a minimal stub is sufficient.
let clients: Record<string, unknown> = {}

mock.module("@/smart-layer", () => ({
  createSmartLayerClients: () => clients,
}))

const importCascade = () => import(`../../src/tool/cascade-blackboard.ts?t=${Date.now()}-${Math.random()}`)

type WriteCall = {
  promptId: string
  agentId: string
  key: string
  value: string
}

function blackboardStub(impl?: (call: WriteCall) => unknown) {
  const write = mock((call: WriteCall) => {
    if (impl) return impl(call)
    return Promise.resolve(undefined)
  })
  return { write }
}

const failedReport = {
  passed: false,
  fixed: false,
  content: "",
  issues: [{ severity: "error" as const, message: "semantics changed", line: 12 }],
  retries: 0,
}

const passedReport = {
  passed: true,
  fixed: false,
  content: "",
  issues: [],
  retries: 0,
}

describe("cascade-blackboard.writeCascadeValidationResult", () => {
  test("writes validation_result when the report failed", async () => {
    const blackboard = blackboardStub()
    clients = { blackboard }
    const { writeCascadeValidationResult } = await importCascade()

    await Effect.runPromise(
      writeCascadeValidationResult({
        promptID: "p1",
        agentID: "agent-1",
        filePath: "src/a.ts",
        report: failedReport,
      }),
    )

    expect(blackboard.write).toHaveBeenCalledTimes(1)
    const call = blackboard.write.mock.calls[0]![0] as WriteCall
    expect(call.promptId).toBe("p1")
    expect(call.agentId).toBe("system:cascade")
    expect(call.key).toBe("validation_result")

    const payload = JSON.parse(call.value)
    expect(payload.status).toBe("failed")
    expect(payload.files).toEqual(["src/a.ts"])
    expect(payload.source).toBe("cascade")
    expect(payload.agent).toBe("agent-1")
    expect(payload.issues).toEqual(failedReport.issues)
    expect(typeof payload.checkedAt).toBe("number")
    expect(payload.message).toContain("Cascade verification failed")
  })

  test("no-ops when promptID is missing", async () => {
    const blackboard = blackboardStub()
    clients = { blackboard }
    const { writeCascadeValidationResult } = await importCascade()

    await Effect.runPromise(
      writeCascadeValidationResult({ agentID: "agent-1", filePath: "src/a.ts", report: failedReport }),
    )

    expect(blackboard.write).not.toHaveBeenCalled()
  })

  test("no-ops when the report is missing", async () => {
    const blackboard = blackboardStub()
    clients = { blackboard }
    const { writeCascadeValidationResult } = await importCascade()

    await Effect.runPromise(
      writeCascadeValidationResult({ promptID: "p1", agentID: "agent-1", filePath: "src/a.ts" }),
    )

    expect(blackboard.write).not.toHaveBeenCalled()
  })

  test("no-ops when the report passed", async () => {
    const blackboard = blackboardStub()
    clients = { blackboard }
    const { writeCascadeValidationResult } = await importCascade()

    await Effect.runPromise(
      writeCascadeValidationResult({
        promptID: "p1",
        agentID: "agent-1",
        filePath: "src/a.ts",
        report: passedReport,
      }),
    )

    expect(blackboard.write).not.toHaveBeenCalled()
  })

  test("no-ops when the blackboard client is unavailable", async () => {
    clients = {}
    const { writeCascadeValidationResult } = await importCascade()

    await Effect.runPromise(
      writeCascadeValidationResult({
        promptID: "p1",
        agentID: "agent-1",
        filePath: "src/a.ts",
        report: failedReport,
      }),
    )
    // Reaching this line is only meaningful because a missing blackboard would
    // otherwise throw on `clients.blackboard.write`; assert the contract anyway.
    expect(clients.blackboard).toBeUndefined()
  })

  test("swallows a failing write so verification never breaks the run", async () => {
    const blackboard = blackboardStub(() => Promise.reject(new Error("blackboard down")))
    clients = { blackboard }
    const { writeCascadeValidationResult } = await importCascade()

    await Effect.runPromise(
      writeCascadeValidationResult({
        promptID: "p1",
        agentID: "agent-1",
        filePath: "src/a.ts",
        report: failedReport,
      }),
    )

    expect(blackboard.write).toHaveBeenCalledTimes(1)
  })
})
