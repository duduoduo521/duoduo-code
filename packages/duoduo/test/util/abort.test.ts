import { describe, expect, test } from "bun:test"
import { abortAfter, abortAfterAny } from "../../src/util/abort"

describe("util.abort", () => {
  describe("abortAfter", () => {
    test("returns controller, signal, and clearTimeout", () => {
      const result = abortAfter(5000)
      expect(result.controller).toBeInstanceOf(AbortController)
      expect(result.signal).toBe(result.controller.signal)
      expect(typeof result.clearTimeout).toBe("function")
      result.clearTimeout()
    })

    test("signal is not aborted immediately", () => {
      const { signal, clearTimeout } = abortAfter(5000)
      expect(signal.aborted).toBe(false)
      clearTimeout()
    })

    test("signal aborts after timeout", async () => {
      const { signal, clearTimeout } = abortAfter(50)
      expect(signal.aborted).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(signal.aborted).toBe(true)
    })

    test("clearTimeout prevents abort", async () => {
      const { signal, clearTimeout } = abortAfter(50)
      clearTimeout()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(signal.aborted).toBe(false)
    })
  })

  describe("abortAfterAny", () => {
    test("returns signal and clearTimeout", () => {
      const result = abortAfterAny(5000)
      expect(result.signal).toBeInstanceOf(AbortSignal)
      expect(typeof result.clearTimeout).toBe("function")
      result.clearTimeout()
    })

    test("aborts on timeout", async () => {
      const { signal, clearTimeout } = abortAfterAny(50)
      expect(signal.aborted).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(signal.aborted).toBe(true)
    })

    test("aborts when any input signal aborts", () => {
      const controller = new AbortController()
      const { signal } = abortAfterAny(50000, controller.signal)
      expect(signal.aborted).toBe(false)
      controller.abort()
      expect(signal.aborted).toBe(true)
    })

    test("clearTimeout prevents timeout abort", async () => {
      const { signal, clearTimeout } = abortAfterAny(50)
      clearTimeout()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(signal.aborted).toBe(false)
    })
  })
})
