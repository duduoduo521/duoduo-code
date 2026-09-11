import { test, expect, mock, beforeEach, afterEach } from "bun:test"
import { EventEmitter } from "events"
import { Effect } from "effect"
import type { MCP as MCPNS } from "../../src/mcp/index"
import { disposeAllWithTimeout } from "../lib/dispose"
import { APP_CONFIG_SCHEMA } from "../../src/config/domains"

// Track open() calls and control failure behavior
let openShouldFail = false
let openCalledWith: string | undefined

void mock.module("open", () => ({
  default: async (url: string) => {
    openCalledWith = url

    // Return a mock subprocess that emits an error if openShouldFail is true
    const subprocess = new EventEmitter()
    if (openShouldFail) {
      // Emit error asynchronously like a real subprocess would
      setTimeout(() => {
        subprocess.emit("error", new Error("spawn xdg-open ENOENT"))
      }, 10)
    }
    return subprocess
  },
}))

// Mock UnauthorizedError
class MockUnauthorizedError extends Error {
  constructor() {
    super("Unauthorized")
    this.name = "UnauthorizedError"
  }
}

// Track what options were passed to each transport constructor
const transportCalls: Array<{
  type: "streamable" | "sse"
  url: string
  options: { authProvider?: unknown }
}> = []

// Mock the transport constructors
void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    url: string
    authProvider: { redirectToAuthorization?: (url: URL) => Promise<void> } | undefined
    constructor(url: URL, options?: { authProvider?: { redirectToAuthorization?: (url: URL) => Promise<void> } }) {
      this.url = url.toString()
      this.authProvider = options?.authProvider
      transportCalls.push({
        type: "streamable",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      // Simulate OAuth redirect by calling the authProvider's redirectToAuthorization
      if (this.authProvider?.redirectToAuthorization) {
        await this.authProvider.redirectToAuthorization(new URL("https://auth.example.com/authorize?client_id=test"))
      }
      throw new MockUnauthorizedError()
    }
    async finishAuth(_code: string) {
      // Mock successful auth completion
    }
  },
}))

void mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(url: URL) {
      transportCalls.push({
        type: "sse",
        url: url.toString(),
        options: {},
      })
    }
    async start() {
      throw new Error("Mock SSE transport cannot connect")
    }
  },
}))

// Mock the MCP SDK Client to trigger OAuth flow
void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    async connect(transport: { start: () => Promise<void> }) {
      await transport.start()
    }
  },
}))

// Mock UnauthorizedError in the auth module
void mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: MockUnauthorizedError,
}))

beforeEach(() => {
  openShouldFail = false
  openCalledWith = undefined
  transportCalls.length = 0
})

afterEach(async () => {
  // Stop the OAuth callback server to release the port and reject pending auth promises
  await McpOAuthCallback.stop()
  await disposeAllWithTimeout()
})

// Import modules after mocking
const { MCP } = await import("../../src/mcp/index")
const { AppRuntime } = await import("../../src/effect/app-runtime")
const { Bus } = await import("../../src/bus")
const { McpOAuthCallback } = await import("../../src/mcp/oauth-callback")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")
const service = MCP.Service as unknown as Effect.Effect<MCPNS.Interface, never, never>

test("BrowserOpenFailed event is published when open() throws", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/duoduo-ai.json`,
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          mcp: {
            "test-oauth-server": {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      openShouldFail = true

      const events: Array<{ mcpName: string; url: string }> = []
      const unsubscribe = await Bus.subscribe(MCP.BrowserOpenFailed, (evt) => {
        events.push(evt.properties)
      })

      // Run authenticate — after open() fails it waits for the user to
      // complete OAuth manually, then times out and returns needs_auth.
      const authPromise = AppRuntime.runPromise(
        Effect.gen(function* () {
          const mcp = yield* service
          return yield* mcp.authenticate("test-oauth-server")
        }),
      )

      // Wait for the BrowserOpenFailed event to be published.
      // The open() mock emits an error after 10ms, then the failure branch
      // publishes the event. Allow extra time for Effect scheduling.
      const eventReceived = new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (events.length > 0) {
            clearInterval(check)
            resolve()
          }
        }, 50)
      })
      await Promise.race([eventReceived, new Promise<void>((resolve) => setTimeout(resolve, 10_000))])

      // Stop the callback server — this rejects the pending callbackPromise,
      // causing the manual-auth Promise.race to reject, which makes
      // authenticate() return { status: "needs_auth" }.
      await McpOAuthCallback.stop()

      // authenticate should now resolve with needs_auth (not hang)
      const result = await Promise.race([
        authPromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5_000)),
      ])

      unsubscribe()

      // Verify the BrowserOpenFailed event was published
      expect(events.length).toBeGreaterThanOrEqual(1)
      expect(events[0].mcpName).toBe("test-oauth-server")
      expect(events[0].url).toContain("https://")

      // Verify authenticate returned needs_auth
      expect(result.status).toBe("needs_auth")
    },
  })
}, 30_000)

test("BrowserOpenFailed event is NOT published when open() succeeds", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/duoduo-ai.json`,
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          mcp: {
            "test-oauth-server-2": {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      openShouldFail = false

      const events: Array<{ mcpName: string; url: string }> = []
      const unsubscribe = await Bus.subscribe(MCP.BrowserOpenFailed, (evt) => {
        events.push(evt.properties)
      })

      // Run authenticate with a timeout to avoid waiting forever for the callback
      const authPromise = AppRuntime.runPromise(
        Effect.gen(function* () {
          const mcp = yield* service
          return yield* mcp.authenticate("test-oauth-server-2")
        }),
      ).catch(() => undefined)

      // Config.get() can be slow in tests; also covers the ~500ms open() error-detection window.
      await new Promise((resolve) => setTimeout(resolve, 2_000))

      // Stop the callback server and cancel any pending auth
      await McpOAuthCallback.stop()

      await Promise.race([authPromise, new Promise<void>((resolve) => setTimeout(resolve, 5_000))])

      unsubscribe()

      // Verify NO BrowserOpenFailed event was published
      expect(events.length).toBe(0)
      // Verify open() was still called
      expect(openCalledWith).toBeDefined()
    },
  })
}, 30_000)

test("open() is called with the authorization URL", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        `${dir}/duoduo-ai.json`,
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          mcp: {
            "test-oauth-server-3": {
              type: "remote",
              url: "https://example.com/mcp",
            },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      openShouldFail = false
      openCalledWith = undefined

      // Run authenticate with a timeout to avoid waiting forever for the callback
      const authPromise = AppRuntime.runPromise(
        Effect.gen(function* () {
          const mcp = yield* service
          return yield* mcp.authenticate("test-oauth-server-3")
        }),
      ).catch(() => undefined)

      // Config.get() can be slow in tests; also covers the ~500ms open() error-detection window.
      await new Promise((resolve) => setTimeout(resolve, 2_000))

      // Stop the callback server and cancel any pending auth
      await McpOAuthCallback.stop()

      await Promise.race([authPromise, new Promise<void>((resolve) => setTimeout(resolve, 5_000))])

      // Verify open was called with a URL
      expect(openCalledWith).toBeDefined()
      expect(typeof openCalledWith).toBe("string")
      expect(openCalledWith!).toContain("https://")
    },
  })
}, 30_000)
