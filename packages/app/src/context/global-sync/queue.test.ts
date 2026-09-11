import { describe, expect, test } from "bun:test"
import { createRefreshQueue } from "./queue"

/** Let every pending `setTimeout(0)` hop of the drain loop run. */
async function flush(times = 20) {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function setup(overrides?: { paused?: () => boolean; bootstrap?: () => Promise<void> }) {
  const calls: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const queue = createRefreshQueue({
    paused: overrides?.paused ?? (() => false),
    bootstrap: overrides?.bootstrap ?? (async () => {}),
    bootstrapInstance: async (dir) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      calls.push(dir)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight--
    },
  })
  return { queue, calls, inFlight: () => maxInFlight }
}

describe("createRefreshQueue", () => {
  test("push adds directory to queue and bootstraps it", async () => {
    const { queue, calls } = setup()
    queue.push("/project-a")
    await flush()
    expect(calls).toEqual(["/project-a"])
    queue.dispose()
  })

  test("push ignores empty directory", async () => {
    const roots: string[] = []
    const { queue, calls } = setup({
      bootstrap: async () => {
        roots.push("root")
      },
    })
    queue.push("")
    await flush()
    expect(calls).toEqual([])
    expect(roots).toEqual([])
    queue.dispose()
  })

  test("clear removes directory from queue", async () => {
    let paused = true
    const { queue, calls } = setup({ paused: () => paused })
    queue.push("/project-a")
    queue.clear("/project-a")
    // Unpause and schedule a drain: only the surviving entry may be processed.
    paused = false
    queue.push("/project-b")
    await flush()
    expect(calls).toEqual(["/project-b"])
    queue.dispose()
  })

  test("refresh sets root flag and runs the root bootstrap", async () => {
    const roots: string[] = []
    const { queue, calls } = setup({
      bootstrap: async () => {
        roots.push("root")
      },
    })
    queue.refresh()
    await flush()
    expect(roots).toEqual(["root"])
    expect(calls).toEqual([])
    queue.dispose()
  })

  test("dispose clears timer so a queued item is never drained", async () => {
    const { queue, calls } = setup()
    queue.push("/project-a")
    queue.dispose()
    await flush()
    expect(calls).toEqual([])
  })

  test("does not process when paused", async () => {
    const roots: string[] = []
    const { queue, calls } = setup({
      paused: () => true,
      bootstrap: async () => {
        roots.push("root")
      },
    })
    queue.push("/project-a")
    queue.refresh()
    await flush()
    expect(calls).toEqual([])
    expect(roots).toEqual([])
    queue.dispose()
  })

  test("deduplicates pushed directories", async () => {
    const { queue, calls } = setup()
    queue.push("/project-a")
    queue.push("/project-a")
    queue.push("/project-a")
    await flush()
    expect(calls).toEqual(["/project-a"])
    queue.dispose()
  })

  test("drains at most two directories at a time and processes every entry", async () => {
    const { queue, calls, inFlight } = setup()
    queue.push("/a")
    queue.push("/b")
    queue.push("/c")
    queue.push("/d")
    await flush(50)
    expect(calls.sort()).toEqual(["/a", "/b", "/c", "/d"])
    expect(inFlight()).toBe(2)
    queue.dispose()
  })
})
