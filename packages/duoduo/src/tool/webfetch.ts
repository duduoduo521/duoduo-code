import { DuoduoError } from "@/util/error"
import z from "zod"
import { Cause, Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Tool from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { isImageAttachment } from "@/util/media"
import dns from "node:dns"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes

/** P2-14 (13-7): WHATWG URL returns bracketed IPv6 hosts ("[::1]") — strip. */
function normalizeHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase()
}

/** Check whether a concrete IP address falls in a private/reserved range. */
function isPrivateIp(ip: string): boolean {
  // IPv4 (dot-decimal) — after DNS resolution all forms collapse to this.
  const parts = ip.split(".")
  if (parts.length === 4) {
    const nums = parts.map(Number)
    if (nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      if (nums[0] === 0 || nums[0] === 10 || nums[0] === 127) return true
      if (nums[0] === 100 && nums[1] === 64) return true
      if (nums[0] === 169 && nums[1] === 254) return true
      if (nums[0] === 172 && nums[1]! >= 16 && nums[1]! <= 31) return true
      if (nums[0] === 192 && nums[1] === 0 && nums[2] === 0) return true
      if (nums[0] === 192 && nums[1] === 168) return true
      return false
    }
  }
  // IPv6 prefixes: loopback, link-local, unique-local, IPv4-mapped.
  const lower = ip.toLowerCase()
  if (lower === "::" || lower === "::1") return true
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true
  if (lower.startsWith("::ffff:")) {
    const mapped = lower.slice("::ffff:".length)
    if (mapped.includes(".")) return isPrivateIp(mapped)
  }
  return false
}

/**
 * P2-14 (13-7): SSRF gate.
 * 1. Literal hostname checks (fast path, includes bracketed IPv6 — the old
 *    `hostname === "::1"` never matched "[::1]").
 * 2. DNS resolution of the hostname and range-checking of EVERY resolved
 *    address — this is what defeats DNS rebinding and exotic IPv4 encodings
 *    (decimal/octal/hex forms), which pure string comparison cannot see.
 */
async function assertPublicHost(hostname: string): Promise<void> {
  const host = normalizeHost(hostname)
  // Cloud metadata endpoints (literal hostnames, no IP form).
  if (host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal" || host === "metadata.azure.com" || host.endsWith(".internal")) {
    throw new DuoduoError({ message: "Requests to private or reserved hosts are not allowed", messageZh: "不允许请求私有或保留主机", cause: undefined })
  }
  // Literal IP fast path.
  if (isPrivateIp(host)) {
    throw new DuoduoError({ message: "Requests to private or reserved IP addresses are not allowed", messageZh: "不允许请求私有或保留 IP 地址", cause: undefined })
  }
  // A literal IP that is public needs no DNS check.
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(":")) return
  // Resolve and check every address (covers rebinding + encoded IPv4).
  // Resolution failure is NOT a hard block: proxied / custom-resolver setups
  // can still reach the host even when this process cannot resolve it — let
  // the real request fail naturally in that case.
  const addresses = await dns.promises
    .lookup(host, { all: true })
    .catch(() => undefined)
  if (!addresses || addresses.length === 0) {
    console.warn(`[webfetch] could not resolve ${host} for SSRF check; proceeding`)
    return
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new DuoduoError({ message: "Requests to private or reserved IP addresses are not allowed", messageZh: "不允许请求私有或保留 IP 地址", cause: undefined })
    }
  }
}

const parameters = z.object({
  url: z.string().describe("The URL to fetch content from"),
  format: z
    .enum(["text", "markdown", "html"])
    .default("markdown")
    .describe("The format to return the content in (text, markdown, or html). Defaults to markdown."),
  timeout: z.number().describe("Optional timeout in seconds (max 120)").optional(),
})

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new DuoduoError({ message: "URL must start with http:// or https://", messageZh: "URL 必须以 http:// 或 https:// 开头", cause: undefined })
          }

          // SSRF protection (P2-14 / 13-7): literal checks + DNS resolution of
          // every address the host maps to (defeats rebinding & encodings).
          yield* Effect.tryPromise(() =>
            assertPublicHost(new URL(params.url).hostname),
          ).pipe(
            Effect.catchCause((c) =>
              Effect.fail(
                (() => {
                  const err = Cause.squash(c)
                  return err instanceof DuoduoError
                    ? err
                    : new DuoduoError({ message: "URL host check failed", messageZh: "URL 主机校验失败", cause: undefined })
                })(),
              ),
            ),
          )

          yield* ctx.ask({
            permission: "webfetch",
            patterns: [params.url],
            always: ["*"],
            metadata: {
              url: params.url,
              format: params.format,
              timeout: params.timeout,
            },
          })

          const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

          // Build Accept header based on requested format with q parameters for fallbacks
          let acceptHeader = "*/*"
          switch (params.format) {
            case "markdown":
              acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
              break
            case "text":
              acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
              break
            case "html":
              acceptHeader =
                "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
              break
            default:
              acceptHeader =
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
          }
          const headers = {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            Accept: acceptHeader,
            "Accept-Language": "en-US,en;q=0.9",
          }

          const request = HttpClientRequest.get(params.url).pipe(HttpClientRequest.setHeaders(headers))

          // Retry with honest UA if blocked by Cloudflare bot detection (TLS fingerprint mismatch)
          const response = yield* httpOk.execute(request).pipe(
            Effect.catchIf(
              (err) =>
                err.reason._tag === "StatusCodeError" &&
                err.reason.response.status === 403 &&
                err.reason.response.headers["cf-mitigated"] === "challenge",
              () =>
                httpOk.execute(
                  HttpClientRequest.get(params.url).pipe(
                    HttpClientRequest.setHeaders({ ...headers, "User-Agent": "duoduo" }),
                  ),
                ),
            ),
            Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(new DuoduoError({ message: "Request timed out", messageZh: "请求超时", cause: undefined })) }),
          )

          // Check content length
          const contentLength = response.headers["content-length"]
          if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
            throw new DuoduoError({ message: "Response too large (exceeds 5MB limit)", messageZh: "响应过大（超过 5MB 限制）", cause: undefined })
          }

          const arrayBuffer = yield* response.arrayBuffer
          if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
            throw new DuoduoError({ message: "Response too large (exceeds 5MB limit)", messageZh: "响应过大（超过 5MB 限制）", cause: undefined })
          }

          const contentType = response.headers["content-type"] || ""
          const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
          const title = `${params.url} (${contentType})`

          if (isImageAttachment(mime)) {
            const base64Content = Buffer.from(arrayBuffer).toString("base64")
            return {
              title,
              output: "Image fetched successfully",
              metadata: {},
              attachments: [
                {
                  type: "file" as const,
                  mime,
                  url: `data:${mime};base64,${base64Content}`,
                },
              ],
            }
          }

          const content = new TextDecoder().decode(arrayBuffer)

          // Handle content based on requested format and actual content type
          switch (params.format) {
            case "markdown":
              if (contentType.includes("text/html")) {
                const markdown = convertHTMLToMarkdown(content)
                return {
                  output: markdown,
                  title,
                  metadata: {},
                }
              }
              return { output: content, title, metadata: {} }

            case "text":
              if (contentType.includes("text/html")) {
                const text = yield* Effect.promise(() => extractTextFromHTML(content))
                return { output: text, title, metadata: {} }
              }
              return { output: content, title, metadata: {} }

            case "html":
              return { output: content, title, metadata: {} }

            default:
              return { output: content, title, metadata: {} }
          }
        }).pipe(Effect.orDie),
    }
  }),
)

async function extractTextFromHTML(html: string) {
  let text = ""
  let skipContent = false

  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, iframe, object, embed", {
      element() {
        skipContent = true
      },
      text() {
        // Skip text content inside these elements
      },
    })
    .on("*", {
      element(element) {
        // Reset skip flag when entering other elements
        if (!["script", "style", "noscript", "iframe", "object", "embed"].includes(element.tagName)) {
          skipContent = false
        }
      },
      text(input) {
        if (!skipContent) {
          text += input.text
        }
      },
    })
    .transform(new Response(html))

  await rewriter.text()
  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}
