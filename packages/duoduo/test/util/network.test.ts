import { describe, expect, test } from "bun:test"
import { online, proxied } from "../../src/util/network"

describe("util.network", () => {
  describe("online", () => {
    test("returns true when navigator is not available", () => {
      const orig = globalThis.navigator
      try {
        // @ts-expect-error - intentionally removing navigator
        delete globalThis.navigator
        expect(online()).toBe(true)
      } finally {
        globalThis.navigator = orig
      }
    })

    test("returns navigator.onLine when available", () => {
      const orig = globalThis.navigator
      try {
        Object.defineProperty(globalThis, "navigator", {
          value: { onLine: true },
          configurable: true,
          writable: true,
        })
        expect(online()).toBe(true)
      } finally {
        globalThis.navigator = orig
      }
    })

    test("returns true when navigator.onLine is not a boolean", () => {
      const orig = globalThis.navigator
      try {
        Object.defineProperty(globalThis, "navigator", {
          value: {},
          configurable: true,
          writable: true,
        })
        expect(online()).toBe(true)
      } finally {
        globalThis.navigator = orig
      }
    })
  })

  describe("proxied", () => {
    test("returns false when no proxy env vars are set", () => {
      const orig = { ...process.env }
      delete process.env.HTTP_PROXY
      delete process.env.HTTPS_PROXY
      delete process.env.http_proxy
      delete process.env.https_proxy
      try {
        expect(proxied()).toBe(false)
      } finally {
        Object.assign(process.env, orig)
      }
    })

    test("returns true when HTTP_PROXY is set", () => {
      const orig = process.env.HTTP_PROXY
      process.env.HTTP_PROXY = "http://proxy:8080"
      try {
        expect(proxied()).toBe(true)
      } finally {
        if (orig === undefined) delete process.env.HTTP_PROXY
        else process.env.HTTP_PROXY = orig
      }
    })

    test("returns true when HTTPS_PROXY is set", () => {
      const orig = process.env.HTTPS_PROXY
      process.env.HTTPS_PROXY = "https://proxy:8443"
      try {
        expect(proxied()).toBe(true)
      } finally {
        if (orig === undefined) delete process.env.HTTPS_PROXY
        else process.env.HTTPS_PROXY = orig
      }
    })

    test("returns true when http_proxy is set", () => {
      const orig = process.env.http_proxy
      process.env.http_proxy = "http://proxy:8080"
      try {
        expect(proxied()).toBe(true)
      } finally {
        if (orig === undefined) delete process.env.http_proxy
        else process.env.http_proxy = orig
      }
    })

    test("returns true when https_proxy is set", () => {
      const orig = process.env.https_proxy
      process.env.https_proxy = "https://proxy:8443"
      try {
        expect(proxied()).toBe(true)
      } finally {
        if (orig === undefined) delete process.env.https_proxy
        else process.env.https_proxy = orig
      }
    })
  })
})
