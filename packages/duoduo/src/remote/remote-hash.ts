import type { Client, ClientChannel } from "ssh2"

/**
 * Remote content hashes (sha256) for every file under a remote root, obtained
 * with ONE `exec` instead of one round trip per file.
 *
 * Why this exists: the sync state identifies the remote side of a file by
 * (mtime, size), and SFTP exposes mtime with 1-second granularity. A remote
 * rewrite landing in the same second AND producing the same byte length is
 * therefore invisible - pull skips the download, push skips the upload, and the
 * two ends silently disagree until the remote mtime moves again.
 *
 * SFTP carries no content checksum (OpenSSH implements no checksum extension),
 * so "did the remote content change" cannot be answered from (mtime, size)
 * alone. Asking the remote to hash its own files answers it exactly.
 *
 * Contract: returns null whenever the answer could not be established - no exec
 * permission (ForceCommand internal-sftp), no hashing command, non-zero exit,
 * timeout, or unparsable output. Callers MUST treat null as unknown and fall
 * back to the (mtime, size) heuristic. null must never be read as "nothing
 * changed": that would miss more than the heuristic does.
 */

const PROBE_TIMEOUT_MS = 15_000
const HASH_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

const HASH_LINE = /^([0-9a-fA-F]{64})[ \t][ *]?(.*)$/

type Captured = { code: number; stdout: string }

function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\"'\"'") + "'"
}

/**
 * find tests that skip the excluded names so the remote never hashes
 * node_modules and friends. Repeated `-name X -prune -o` rather than a
 * parenthesised group: same pruning, no shell escaping needed.
 */
function pruneTests(exclude: Set<string>): string {
  return [...exclude]
    .filter(Boolean)
    .map((name) => `-name ${shellQuote(name)} -prune -o`)
    .join(" ")
}

async function execCapture(client: Client, command: string, timeoutMs: number): Promise<Captured | null> {
  return new Promise<Captured | null>((resolve) => {
    let settled = false
    let channel: ClientChannel | undefined
    const finish = (value: Captured | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (channel) {
        channel.removeAllListeners()
        try {
          channel.close()
        } catch {
          // already closed
        }
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)

    client.exec(command, (err, stream) => {
      if (err || !stream) return finish(null)
      channel = stream
      let out = ""
      let overflowed = false
      stream.on("data", (chunk: Buffer) => {
        if (overflowed) return
        if (out.length + chunk.length > MAX_OUTPUT_BYTES) {
          overflowed = true
          return
        }
        out += chunk.toString("utf-8")
      })
      stream.stderr?.on("data", () => {})
      stream.on("error", () => finish(null))
      stream.on("close", (code: number | null) => {
        if (overflowed) return finish(null)
        finish({ code: code ?? -1, stdout: out })
      })
    })
  })
}

async function detectHashCommand(client: Client): Promise<string | null> {
  const probe = await execCapture(
    client,
    "command -v sha256sum 2>/dev/null; command -v shasum 2>/dev/null",
    PROBE_TIMEOUT_MS,
  )
  if (!probe) return null
  const found = probe.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  // macOS ships no sha256sum, only shasum.
  if (found.some((p) => p === "sha256sum" || p.endsWith("/sha256sum"))) return "sha256sum"
  if (found.some((p) => p === "shasum" || p.endsWith("/shasum"))) return "shasum -a 256"
  return null
}

function normalizeRel(raw: string): string | undefined {
  let value = raw.trim()
  if (value.startsWith("\\")) value = value.slice(1)
  value = value.replace(/^\.\//, "").replace(/^\/+/, "")
  if (!value || value === "." || value === "..") return undefined
  return value
}

export async function remoteContentHashes(input: {
  client: Client
  root: string
  exclude: Set<string>
}): Promise<Map<string, string> | null> {
  const command = await detectHashCommand(input.client)
  if (!command) return null

  const script = `cd ${shellQuote(input.root)} && find . ${pruneTests(input.exclude)} -type f -exec ${command} {} +`
  const result = await execCapture(input.client, script, HASH_TIMEOUT_MS)
  if (!result || result.code !== 0) return null

  const hashes = new Map<string, string>()
  let lines = 0
  let parsed = 0
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue
    lines += 1
    const match = HASH_LINE.exec(line)
    if (!match) continue
    const rel = normalizeRel(match[2]!)
    if (rel === undefined) continue
    hashes.set(rel, match[1]!.toLowerCase())
    parsed += 1
  }
  // A listing we could not read at all is unusable, not empty.
  if (lines > 0 && parsed === 0) return null
  return hashes
}

/**
 * Remote directories that are COMPLETELY empty (`find -type d -empty`), one
 * exec for the whole tree. Used by push to sweep away "ghost" directories: an
 * earlier deletion whose directory prune failed (or content a teammate emptied)
 * leaves empty dirs on the server, and the next pull mirrors them back to the
 * local tree as empty shells — the folders keep "coming back".
 *
 * Excluded subtrees (node_modules & friends) are pruned from the find and never
 * reported. Returns null when the listing could not be established (no exec
 * permission, non-zero exit, timeout) — callers MUST treat null as unknown and
 * simply skip the sweep, never as "no empty dirs".
 */
export async function remoteListEmptyDirs(input: {
  client: Client
  root: string
  exclude: Set<string>
}): Promise<string[] | null> {
  const script = `cd ${shellQuote(input.root)} && find . ${pruneTests(input.exclude)} -type d -empty`
  const result = await execCapture(input.client, script, HASH_TIMEOUT_MS)
  if (!result || result.code !== 0) return null
  return result.stdout
    .split("\n")
    .map(normalizeRel)
    .filter((v): v is string => v !== undefined)
}
