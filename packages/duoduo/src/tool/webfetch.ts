import { DuoduoError } from "@/util/error"
import z from "zod"
import { Cause, Effect, Option } from "effect"
import { FetchHttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Tool from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { isImageAttachment } from "@/util/media"
import { Config } from "../config"
import dns from "node:dns"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes
const MAX_REDIRECTS = 5

/** P2-14 (13-7): WHATWG URL returns bracketed IPv6 hosts ("[::1]") — strip. */
function normalizeHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase()
}

// ─── H4: user-managed network access policy ─────────────────────────────────
// The blocklist is USER DATA, not code: the defaults below are protocol-
// standard special-purpose ranges (IANA registry — nothing here asserts a
// vendor fact like "this IP belongs to some cloud's metadata service"). They
// ship as editable rules in the settings UI; users can delete, add, and
// modify any of them, flip between blacklist mode (default: allow unless a
// block rule matches) and whitelist mode (block unless an allow rule
// matches), and exempt specific hosts with more-specific allow rules.

export type WebfetchAccessMode = "blacklist" | "whitelist"

export interface WebfetchRule {
  pattern: string // IP, CIDR (v4/v6), domain, or "*.domain"
  action: "allow" | "block"
  enabled: boolean
}

export const DEFAULT_WEBFETCH_RULES: readonly WebfetchRule[] = [
  { pattern: "localhost", action: "block", enabled: true },
  { pattern: "*.localhost", action: "block", enabled: true },
  { pattern: "*.internal", action: "block", enabled: true },
  { pattern: "0.0.0.0/8", action: "block", enabled: true },
  { pattern: "10.0.0.0/8", action: "block", enabled: true },
  { pattern: "127.0.0.0/8", action: "block", enabled: true },
  { pattern: "169.254.0.0/16", action: "block", enabled: true },
  { pattern: "172.16.0.0/12", action: "block", enabled: true },
  { pattern: "192.168.0.0/16", action: "block", enabled: true },
  { pattern: "100.64.0.0/10", action: "block", enabled: true },
  { pattern: "::1/128", action: "block", enabled: true },
  { pattern: "fe80::/10", action: "block", enabled: true },
  { pattern: "fc00::/7", action: "block", enabled: true },
]

/** Normalize IPv4-mapped IPv6 to plain dotted IPv4. Covers BOTH textual
 * forms: "::ffff:127.0.0.1" (dotted) and "::ffff:7f00:1" (hex) — the old
 * `isPrivateIp` saw only the dotted one. */
export function normalizeIPv4Mapped(ip: string): string {
  const lower = ip.toLowerCase()
  if (!lower.startsWith("::ffff:")) return lower
  const tail = lower.slice("::ffff:".length)
  if (tail.includes(".")) return tail
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
  if (!m) return lower
  const hi = parseInt(m[1]!, 16)
  const lo = parseInt(m[2]!, 16)
  return `${(hi >>> 8) & 255}.${hi & 255}.${(lo >>> 8) & 255}.${lo & 255}`
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".")
  if (parts.length !== 4) return undefined
  let out = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined
    const n = Number(p)
    if (n > 255) return undefined
    out = out * 256 + n
  }
  return out >>> 0
}

function ipv6ToBigInt(ip: string): bigint | undefined {
  let head = ip
  const dot = ip.lastIndexOf(".")
  if (dot !== -1) {
    // Embedded dotted-quad tail ("::ffff:1.2.3.4"): replace with two hex
    // groups so the standard parse below handles it.
    const v4parts = ip.slice(dot + 1).split(".")
    if (v4parts.length !== 4) return undefined
    const nums = v4parts.map((p) => Number(p))
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined
    const hi = ((nums[0]! << 8) | nums[1]!) & 0xffff
    const lo = ((nums[2]! << 8) | nums[3]!) & 0xffff
    head = `${ip.slice(0, dot)}:${hi.toString(16)}:${lo.toString(16)}`
  }
  const dc = head.indexOf("::")
  let groups: string[]
  if (dc !== -1) {
    if (head.indexOf("::", dc + 1) !== -1) return undefined
    const left = head.slice(0, dc).split(":").filter((g) => g !== "")
    const right = head.slice(dc + 2).split(":").filter((g) => g !== "")
    const fill = 8 - left.length - right.length
    if (fill < 1) return undefined
    groups = [...left, ...Array<string>(fill).fill("0"), ...right]
  } else {
    groups = head.split(":")
    if (groups.length !== 8) return undefined
  }
  let value = 0n
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined
    value = (value << 16n) | BigInt(parseInt(g, 16))
  }
  return value
}

/** True when `ip` falls inside `pattern` (exact IP or CIDR, v4/v6). */
export function ipMatchesPattern(ip: string, pattern: string): boolean {
  const normalized = normalizeIPv4Mapped(ip)
  const slash = pattern.indexOf("/")
  const base = normalizeIPv4Mapped(slash === -1 ? pattern : pattern.slice(0, slash))
  const prefixLen = slash === -1 ? undefined : Number(pattern.slice(slash + 1))
  const ipIsV4 = normalized.includes(".") && !normalized.includes(":")
  const baseIsV4 = base.includes(".") && !base.includes(":")
  if (ipIsV4 !== baseIsV4) return false
  if (ipIsV4) {
    const ipInt = ipv4ToInt(normalized)
    const baseInt = ipv4ToInt(base)
    if (ipInt === undefined || baseInt === undefined) return false
    const len = prefixLen ?? 32
    if (!Number.isInteger(len) || len < 0 || len > 32) return false
    if (len === 0) return true
    const mask = (0xffffffff << (32 - len)) >>> 0
    return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0)
  }
  const ipBig = ipv6ToBigInt(normalized)
  const baseBig = ipv6ToBigInt(base)
  if (ipBig === undefined || baseBig === undefined) return false
  const len = prefixLen ?? 128
  if (!Number.isInteger(len) || len < 0 || len > 128) return false
  if (len === 0) return true
  const shift = BigInt(128 - len)
  return ipBig >> shift === baseBig >> shift
}

/** Domain rules match hostnames only: exact, or "*.suffix" (subdomains). */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase()
  const h = host.toLowerCase()
  if (p.startsWith("*.")) return h.endsWith(`.${p.slice(2)}`)
  return h === p
}

export interface EffectivePolicy {
  mode: WebfetchAccessMode
  rules: readonly WebfetchRule[]
}

/**
 * Evaluate ONE target against the policy. Most-specific match wins (longer
 * CIDR prefix / more domain labels); equal specificity resolves to allow —
 * so a precise allow rule can exempt a host from a broader block rule.
 * Unmatched targets follow the mode: blacklist → allow, whitelist → block.
 */
export function evaluatePolicy(
  target: { kind: "ip"; ip: string } | { kind: "host"; host: string },
  policy: EffectivePolicy,
): "allow" | "block" {
  const rules =
    policy.mode === "blacklist" ? [...policy.rules, ...DEFAULT_WEBFETCH_RULES] : policy.rules
  let bestAction: "allow" | "block" | undefined
  let bestScore = -1
  for (const rule of rules) {
    if (!rule.enabled) continue
    let score: number | undefined
    if (target.kind === "ip") {
      if (ipMatchesPattern(target.ip, rule.pattern)) {
        const slash = rule.pattern.indexOf("/")
        if (slash === -1) {
          // exact-IP rule: highest specificity for its family
          score = target.ip.includes(".") && !target.ip.includes(":") ? 32 : 128
        } else {
          const len = Number(rule.pattern.slice(slash + 1))
          score = Number.isInteger(len) && len >= 0 ? len : 0
        }
      }
    } else {
      if (hostMatchesPattern(target.host, rule.pattern)) {
        score = rule.pattern.split(".").length + (rule.pattern.startsWith("*.") ? 0 : 100)
      }
    }
    if (score === undefined) continue
    if (score > bestScore || (score === bestScore && bestAction === "block" && rule.action === "allow")) {
      bestScore = score
      bestAction = rule.action
    }
  }
  if (bestAction) return bestAction
  return policy.mode === "whitelist" ? "block" : "allow"
}

const isV4Literal = (s: string) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s)

/**
 * H4 policy gate for ONE hostname (a redirect hop). Literal IPs are
 * evaluated directly; domain names first hit domain rules (no DNS needed),
 * then EVERY resolved address is evaluated — the DNS-rebinding defence.
 * Resolution failure stays fail-open (proxied / custom-resolver setups), a
 * pre-declared boundary.
 */
export async function checkHostPolicy(hostname: string, policy: EffectivePolicy): Promise<void> {
  const deny = (detail: string) =>
    new DuoduoError({
      message: `Request blocked by the network access policy (${detail})`,
      messageZh: `请求已被网络访问控制策略拦截（${detail}）`,
      cause: undefined,
    })
  const host = normalizeHost(hostname)
  const mapped = normalizeIPv4Mapped(host)
  if (isV4Literal(mapped) || host.includes(":")) {
    if (evaluatePolicy({ kind: "ip", ip: mapped }, policy) === "block")
      throw deny(`IP ${host} is not allowed by the configured rules or access mode`)
    return
  }
  if (evaluatePolicy({ kind: "host", host }, policy) === "block")
    throw deny(`host ${host} is not allowed by the configured rules or access mode`)
  const addresses = await dns.promises
    .lookup(host, { all: true })
    .catch(() => undefined)
  if (!addresses || addresses.length === 0) {
    console.warn(`[webfetch] could not resolve ${host} for the access-policy check; proceeding`)
    return
  }
  for (const { address } of addresses) {
    if (evaluatePolicy({ kind: "ip", ip: normalizeIPv4Mapped(address) }, policy) === "block")
      throw deny(`host ${host} resolves to ${address}, which is not allowed`)
  }
}

/** Read the effective policy from config (live — UI edits apply immediately).
 * Runs INSIDE the caller's effect context (a bare runPromise here would lose
 * the Config service and silently disable every user rule). Falls back to the
 * safe default (blacklist + built-in reserved-range rules) when the config
 * service is unavailable — webfetch must keep working and the default
 * blocklist still guards the reserved ranges. */
export function readPolicy(): Effect.Effect<EffectivePolicy, never, never> {
  return Effect.gen(function* () {
    const fallback = { mode: "blacklist", rules: [] } satisfies EffectivePolicy
    const serviceOpt = yield* Effect.serviceOption(Config.Service)
    const config = Option.getOrUndefined(serviceOpt)
    if (!config) {
      console.warn("[webfetch] config unavailable; falling back to the default access policy")
      return fallback
    }
    const cfgResult = yield* config.get().pipe(
      Effect.map((cfg) => ({ _tag: "ok" as const, cfg })),
      Effect.catchCause(() => Effect.succeed({ _tag: "err" as const })),
    )
    if (cfgResult._tag === "err") {
      console.warn("[webfetch] config read failed; falling back to the default access policy")
      return fallback
    }
    const cfg = cfgResult.cfg
    const mode: WebfetchAccessMode = cfg.webfetch_access_mode === "whitelist" ? "whitelist" : "blacklist"
    const raw = Array.isArray(cfg.webfetch_rules) ? cfg.webfetch_rules : []
    const rules: WebfetchRule[] = []
    for (const r of raw) {
      if (!r || typeof r !== "object") continue
      const rec = r as Record<string, unknown>
      if (typeof rec.pattern !== "string" || rec.pattern.trim() === "") continue
      if (rec.action !== "allow" && rec.action !== "block") continue
      rules.push({ pattern: rec.pattern.trim(), action: rec.action, enabled: rec.enabled !== false })
    }
    return { mode, rules } satisfies EffectivePolicy
  })
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
    // H4: fetch is taken from the Fetch service (same injection point the
    // tests mock) — the tool runs its own MANUAL redirect loop so every hop
    // can be policy-checked before it leaves the process.
    const fetchImpl = yield* FetchHttpClient.Fetch

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new DuoduoError({ message: "URL must start with http:// or https://", messageZh: "URL 必须以 http:// 或 https:// 开头", cause: undefined })
          }

          // effect v4 tryPromise wraps rejections in UnknownError with the
          // original error on `.cause` — unwrap before the instanceof check,
          // otherwise a DuoduoError thrown by checkHostPolicy loses its
          // specific message and surfaces as the generic fallback.
          const unwrapCaused = (err: unknown): unknown => {
            const cause = (err as { cause?: unknown } | undefined)?.cause
            return cause !== undefined ? cause : err
          }
          const wrapCause = (fallback: { message: string; messageZh: string }) =>
            Effect.catchCause((c: Cause.Cause<unknown>) =>
              Effect.fail(
                (() => {
                  const err = unwrapCaused(Cause.squash(c))
                  return err instanceof DuoduoError ? err : new DuoduoError({ ...fallback, cause: undefined })
                })(),
              ),
            )

          // H4: load the user-managed access policy (live config read).
          const policy = yield* readPolicy()

          // H4: gate the FIRST hop (literal-IP / domain rules + DNS of every
          // resolved address — the DNS-rebinding defence, preserved from
          // P2-14/13-7 but now policy-driven instead of hard-coded).
          const firstUrl = new URL(params.url)
          yield* Effect.tryPromise(() => checkHostPolicy(firstUrl.hostname, policy)).pipe(
            wrapCause({ message: "URL host check failed", messageZh: "URL 主机校验失败" }),
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

          // H4: MANUAL redirect loop — every hop re-runs the access policy
          // (domain rules + DNS resolution of all its addresses) BEFORE the
          // request is issued. The old fetch auto-follow followed a 302 into
          // an internal address with no re-check (SSRF). A single deadline
          // covers the whole hop chain, matching the previous total-budget
          // semantics of Effect.timeout around the (then unredirected) call.
          const deadline = Date.now() + timeout
          const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
          let currentUrl = firstUrl
          let response: Response | undefined
          for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (hop > 0) {
              const remaining = deadline - Date.now()
              if (remaining <= 0) {
                throw new DuoduoError({ message: "Request timed out", messageZh: "请求超时", cause: undefined })
              }
              yield* Effect.tryPromise(() => checkHostPolicy(currentUrl.hostname, policy)).pipe(
                wrapCause({ message: "URL host check failed", messageZh: "URL 主机校验失败" }),
              )
            }
            const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
            const res = yield* Effect.tryPromise(() =>
              fetchImpl(currentUrl, { redirect: "manual", headers, signal }),
            ).pipe(wrapCause({ message: "Request failed", messageZh: "请求失败" }))
            if (res.status === 403 && res.headers.get("cf-mitigated") === "challenge") {
              // Retry once with the honest UA (Cloudflare bot detection).
              response = yield* Effect.tryPromise(() =>
                fetchImpl(currentUrl, {
                  redirect: "manual",
                  headers: { ...headers, "User-Agent": "duoduo" },
                  signal,
                }),
              ).pipe(wrapCause({ message: "Request failed", messageZh: "请求失败" }))
              break
            }
            if (REDIRECT_STATUSES.has(res.status)) {
              const location = res.headers.get("location")
              if (location) {
                if (hop === MAX_REDIRECTS) {
                  throw new DuoduoError({ message: "Too many redirects", messageZh: "重定向次数过多", cause: undefined })
                }
                currentUrl = new URL(location, currentUrl)
                continue
              }
            }
            response = res
            break
          }
          if (!response) {
            throw new DuoduoError({ message: "Request failed", messageZh: "请求失败", cause: undefined })
          }

          // Check content length
          const contentLength = response.headers.get("content-length")
          if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
            throw new DuoduoError({ message: "Response too large (exceeds 5MB limit)", messageZh: "响应过大（超过 5MB 限制）", cause: undefined })
          }

          const arrayBuffer = yield* Effect.promise(() => response.arrayBuffer())
          if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
            throw new DuoduoError({ message: "Response too large (exceeds 5MB limit)", messageZh: "响应过大（超过 5MB 限制）", cause: undefined })
          }

          const contentType = response.headers.get("content-type") || ""
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
