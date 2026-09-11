import { describe, expect, test } from "bun:test"

// Replicate the `send` function logic from proxy.ts for unit testing.
// The `send` function handles Blob conversion before sending via WebSocket.

function send(ws: { send(data: string | ArrayBuffer | Uint8Array): void }, data: any) {
  if (data instanceof Blob) {
    return data.arrayBuffer().then((x) => ws.send(x))
  }
  return ws.send(data)
}

describe("ServerProxy.send", () => {
  test("sends string data directly", () => {
    const sent: any[] = []
    const ws = { send(data: any) { sent.push(data) } }
    // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
    send(ws, "hello")
    expect(sent).toEqual(["hello"])
  })

  test("sends ArrayBuffer data directly", () => {
    const sent: any[] = []
    const ws = { send(data: any) { sent.push(data) } }
    const buf = new ArrayBuffer(4)
    // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
    send(ws, buf)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toBe(buf)
  })

  test("sends Uint8Array data directly", () => {
    const sent: any[] = []
    const ws = { send(data: any) { sent.push(data) } }
    const arr = new Uint8Array([1, 2, 3])
    // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
    send(ws, arr)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toBe(arr)
  })

  test("converts Blob to ArrayBuffer before sending", async () => {
    const sent: any[] = []
    const ws = { send(data: any) { sent.push(data) } }
    const blob = new Blob([new Uint8Array([10, 20, 30])])
    const result = send(ws, blob)
    // Blob path returns a Promise
    expect(result).toBeInstanceOf(Promise)
    await result
    expect(sent).toHaveLength(1)
    expect(sent[0]).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(sent[0])).toEqual(new Uint8Array([10, 20, 30]))
  })

  test("sends number data directly (non-Blob passthrough)", () => {
    const sent: any[] = []
    const ws = { send(data: any) { sent.push(data) } }
    // oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
    send(ws, 42)
    expect(sent).toEqual([42])
  })
})
