import { describe, expect, test } from "bun:test"
import type { NamedError } from "@duoduo-ai/shared/util/error"
import { APICallError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Schedule } from "effect"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderID } from "../../src/provider/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const providerID = ProviderID.make("test")

function apiError(headers?: Record<string, string>): MessageV2.APIError {
  return new MessageV2.APIError({
    message: "boom",
    isRetryable: true,
    responseHeaders: headers,
  }).toObject()
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { data: { message } } as ReturnType<NamedError["toObject"]>
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("caps header delays above the 60s runtime cap (P2-2)", () => {
    // Sub-cap values pass through unchanged.
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    // P2-2: RETRY_MAX_DELAY is now 60s — an 11.6-minute Retry-After is capped
    // (previously 2^31-1 let multi-minute stalls through).
    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })

  test("caps oversized header delays to the runtime timer limit", () => {
    const error = apiError({ "retry-after-ms": "999999999999" })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })

  test("policy updates retry status and increments attempts", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("session-retry-test")
        const error = apiError({ "retry-after-ms": "0" })

        await Effect.runPromise(
          Effect.gen(function* () {
            const step = yield* Schedule.toStepWithMetadata(
              SessionRetry.policy({
                parse: (err) => err as MessageV2.APIError,
                set: (info) =>
                  Effect.promise(() =>
                    AppRuntime.runPromise(
                      SessionStatus.Service.use((svc) =>
                        svc.set(sessionID, {
                          type: "retry",
                          attempt: info.attempt,
                          message: info.message,
                          next: info.next,
                        }),
                      ),
                    ),
                  ),
              }),
            )
            yield* step(error)
            yield* step(error)
          }),
        )

        expect(await AppRuntime.runPromise(SessionStatus.Service.use((svc) => svc.get(sessionID)))).toMatchObject({
          type: "retry",
          attempt: 2,
          message: "boom",
        })
      },
    })
  })
})

describe("session.retry.retryable", () => {
  test("maps too_many_requests json messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error)).toBe("Too Many Requests")
  })

  test("maps overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error)).toBe("Provider is overloaded")
  })

  test("does not retry unknown json messages", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("retries plain text rate limit errors from Alibaba", () => {
    const msg =
      "Upstream error from Alibaba: Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."
    const error = wrap(msg)
    expect(SessionRetry.retryable(error)).toBe(msg)
  })

  test("retries plain text rate limit errors", () => {
    const msg = "Rate limit exceeded, please try again later"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error)).toBe(msg)
  })

  test("retries too many requests in plain text", () => {
    const msg = "Too many requests, please slow down"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error)).toBe(msg)
  })

  test("does not retry context overflow errors", () => {
    const error = new MessageV2.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject() as ReturnType<NamedError["toObject"]>

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("does not retry Xunfei 10012 with InvalidParameter (context overflow)", () => {
    // This is the exact error Xunfei returns when context is exceeded:
    // code: 10012, msg: EngineInternalError:error, message: <400> InternalError.Algo.InvalidParameter: Range of input length should be [1, 202745]
    const msg =
      "Xunfei request failed with Sid: cht000e9545 code: 10012, msg: EngineInternalError:error, status code: 400, message: InternalError.Algo.InvalidParameter: Range of input length should be [1, 202745]"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("does not retry Xunfei 10012 overflow in JSON body", () => {
    const error = wrap(
      JSON.stringify({
        type: "error",
        error: {
          code: "10012",
          message: "InternalError.Algo.InvalidParameter: Range of input length should be [1, 202745]",
        },
      }),
    )
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("retries Xunfei 10012 without overflow keywords (genuine engine error)", () => {
    const msg =
      "Xunfei request failed with Sid: cht000e9545 code: 10012, msg: EngineInternalError:error, please try again later"
    const error = wrap(msg)
    expect(SessionRetry.retryable(error)).toBe(msg)
  })

  test("retries 500 errors even when isRetryable is false", () => {
    const error = new MessageV2.APIError({
      message: "Internal server error",
      isRetryable: false,
      statusCode: 500,
      responseBody: '{"type":"api_error","message":"Internal server error"}',
    }).toObject()

    expect(SessionRetry.retryable(error)).toBe("Internal server error")
  })

  test("retries 502 bad gateway errors", () => {
    const error = new MessageV2.APIError({
      message: "Bad gateway",
      isRetryable: false,
      statusCode: 502,
    }).toObject()

    expect(SessionRetry.retryable(error)).toBe("Bad gateway")
  })

  test("retries 503 service unavailable errors", () => {
    const error = new MessageV2.APIError({
      message: "Service unavailable",
      isRetryable: false,
      statusCode: 503,
    }).toObject()

    expect(SessionRetry.retryable(error)).toBe("Service unavailable")
  })

  test("does not retry 4xx errors when isRetryable is false", () => {
    const error = new MessageV2.APIError({
      message: "Bad request",
      isRetryable: false,
      statusCode: 400,
    }).toObject()

    expect(SessionRetry.retryable(error)).toBeUndefined()
  })

  test("retries ZlibError decompression failures", () => {
    const error = new MessageV2.APIError({
      message: "Response decompression failed",
      isRetryable: true,
      metadata: { code: "ZlibError" },
    }).toObject()

    const retryable = SessionRetry.retryable(error)
    expect(retryable).toBeDefined()
    expect(retryable).toBe("Response decompression failed")
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(_req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID })

      expect(MessageV2.APIError.isInstance(result)).toBe(true)
      expect((result).data.isRetryable).toBe(true)
      expect((result).data.message).toBe("Connection error: ECONNRESET")
      expect((result).data.metadata?.code).toBe("ECONNRESET")
      expect((result).data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = new MessageV2.APIError({
      message: "Connection reset by server",
      isRetryable: true,
      metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
    }).toObject()

    const retryable = SessionRetry.retryable(error)
    expect(retryable).toBeDefined()
    expect(retryable).toBe("Connection reset by server")
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: ProviderID.make("openai") })
    expect(result.data.isRetryable).toBe(true)
  })
})
