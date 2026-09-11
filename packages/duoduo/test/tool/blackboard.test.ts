import { Effect } from "effect"
import { fetchSkipSyntaxCheck } from "@/tool/blackboard"
import { createSmartLayerClients } from "@/smart-layer"

type Clients = ReturnType<typeof createSmartLayerClients>

function clientsWith(getLoopConfig: () => Promise<unknown>): Clients {
  return { agent: { getLoopConfig } } as unknown as Clients
}

function emptyClients(): Clients {
  return {} as unknown as Clients
}

describe("fetchSkipSyntaxCheck (P3 TS pass-through)", () => {
  it("returns true when loop config syntaxCheck === false (L1 gate off)", async () => {
    const r = await Effect.runPromise(
      fetchSkipSyntaxCheck(clientsWith(() => Promise.resolve({ syntaxCheck: false }))),
    )
    expect(r).toBe(true)
  })

  it("returns false when loop config syntaxCheck === true (L1 gate on)", async () => {
    const r = await Effect.runPromise(
      fetchSkipSyntaxCheck(clientsWith(() => Promise.resolve({ syntaxCheck: true }))),
    )
    expect(r).toBe(false)
  })

  it("returns false (gate ON) when clients.agent is missing", async () => {
    const r = await Effect.runPromise(fetchSkipSyntaxCheck(emptyClients()))
    expect(r).toBe(false)
  })

  it("returns false (gate ON) when getLoopConfig rejects — fallback must never disable the gate", async () => {
    const r = await Effect.runPromise(
      fetchSkipSyntaxCheck(clientsWith(() => Promise.reject(new Error("boom")))),
    )
    expect(r).toBe(false)
  })
})
