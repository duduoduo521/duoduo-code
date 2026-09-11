import { describe, expect, test } from "bun:test"
import { AsyncQueue, work } from "../../src/util/queue"

describe("util.queue", () => {
  describe("AsyncQueue", () => {
    test("push and next deliver items in order", async () => {
      const q = new AsyncQueue<number>()
      q.push(1)
      q.push(2)
      q.push(3)
      expect(await q.next()).toBe(1)
      expect(await q.next()).toBe(2)
      expect(await q.next()).toBe(3)
    })

    test("next blocks until item is pushed", async () => {
      const q = new AsyncQueue<string>()
      const promise = q.next()
      q.push("hello")
      expect(await promise).toBe("hello")
    })

    test("resolves waiting consumers on push", async () => {
      const q = new AsyncQueue<number>()
      const p1 = q.next()
      const p2 = q.next()
      q.push(10)
      q.push(20)
      expect(await p1).toBe(10)
      expect(await p2).toBe(20)
    })

    test("is async iterable", async () => {
      const q = new AsyncQueue<number>()
      q.push(1)
      q.push(2)

      const results: number[] = []
      const iterator = q[Symbol.asyncIterator]()
      results.push((await iterator.next()).value as number)
      results.push((await iterator.next()).value as number)
      expect(results).toEqual([1, 2])
    })
  })

  describe("work", () => {
    test("processes all items", async () => {
      const processed: number[] = []
      await work(2, [1, 2, 3, 4], async (item) => {
        processed.push(item)
      })
      expect(processed.sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    })

    test("respects concurrency limit", async () => {
      let concurrent = 0
      let maxConcurrent = 0
      await work(2, [1, 2, 3, 4, 5], async () => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((r) => setTimeout(r, 10))
        concurrent--
      })
      expect(maxConcurrent).toBeLessThanOrEqual(2)
    })

    test("handles empty items array", async () => {
      const processed: number[] = []
      await work(3, [], async (item) => {
        processed.push(item)
      })
      expect(processed).toEqual([])
    })

    test("handles concurrency of 1 (sequential)", async () => {
      const order: number[] = []
      await work(1, [1, 2, 3], async (item) => {
        order.push(item)
      })
      // With concurrency 1, items are processed from the end (pop)
      expect(order.sort((a, b) => a - b)).toEqual([1, 2, 3])
    })
  })
})
