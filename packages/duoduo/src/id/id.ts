import z from "zod"
import { randomBytes } from "crypto"

const prefixes = {
  event: "evt",
  session: "ses",
  message: "msg",
  permission: "per",
  question: "que",
  user: "usr",
  part: "prt",
  pty: "pty",
  tool: "tool",
  workspace: "wrk",
  entry: "ent",
} as const

export function schema(prefix: keyof typeof prefixes) {
  return z.string().startsWith(prefixes[prefix])
}

const LENGTH = 26

// State for monotonic ID generation
let lastTimestamp = 0
let counter = 0

export function ascending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "ascending", given)
}

export function descending(prefix: keyof typeof prefixes, given?: string) {
  return generateID(prefix, "descending", given)
}

function generateID(prefix: keyof typeof prefixes, direction: "descending" | "ascending", given?: string): string {
  if (!given) {
    return create(prefixes[prefix], direction)
  }

  if (!given.startsWith(prefixes[prefix])) {
    throw new Error(`ID ${given} does not start with ${prefixes[prefix]}`)
  }
  return given
}

function randomBase62(length: number): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let result = ""
  const bytes = randomBytes(length)
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i]! % 62]!
  }
  return result
}

export function create(prefix: string, direction: "descending" | "ascending", timestamp?: number): string {
  const currentTimestamp = timestamp ?? Date.now()

  if (currentTimestamp !== lastTimestamp) {
    lastTimestamp = currentTimestamp
    counter = 0
  }
  counter++

  let now = BigInt(currentTimestamp) * BigInt(0x1000) + BigInt(counter)

  now = direction === "descending" ? ~now : now

  const timeBytes = Buffer.alloc(6)
  for (let i = 0; i < 6; i++) {
    timeBytes[i] = Number((now >> BigInt(40 - 8 * i)) & BigInt(0xff))
  }

  return prefix + "_" + timeBytes.toString("hex") + randomBase62(LENGTH - 12)
}

/** Extract the sort key (hex-encoded timestamp portion) from an ID.
 *
 * This returns the 12-character hex string that encodes the timestamp,
 * which can be used for lexicographic comparison of IDs by creation time.
 * For ascending IDs, later IDs have larger sort keys; for descending IDs,
 * later IDs have smaller sort keys.
 *
 * Note: The 48-bit encoding overflows for real-world epoch-ms timestamps
 * (overflow point: ~1972-01), so the absolute timestamp value is not
 * recoverable. However, relative ordering is preserved within a ~2,177-year
 * window, which is sufficient for all practical use cases.
 */
export function sortKey(id: string): string {
  const prefix = id.split("_")[0]!
  return id.slice(prefix.length + 1, prefix.length + 13)
}

/** @deprecated Use sortKey() for comparison or extract timestamp from
 *  application-level metadata instead. The 48-bit encoding overflows for
 *  real-world timestamps, making the returned value inaccurate in absolute
 *  terms. Relative comparisons remain correct within a ~2,177-year window. */
export function timestamp(id: string): number {
  const prefix = id.split("_")[0]!
  const hex = id.slice(prefix.length + 1, prefix.length + 13)
  const encoded = BigInt("0x" + hex)
  return Number(encoded / BigInt(0x1000))
}

export * as Identifier from "./id"
