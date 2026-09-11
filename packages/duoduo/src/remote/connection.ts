import { Client, type SFTPWrapper } from "ssh2"
import { Log } from "../util"
import { errorMessage } from "../util/error"

const log = Log.create({ service: "remote-connection" })

export interface ResolvedSecret {
  username: string
  password?: string
  privateKey?: Buffer
  passphrase?: string
}

interface Pooled {
  client: Client
  sftp: SFTPWrapper
  refCount: number
}

/**
 * Connection cache keyed by host/port/username/auth (no secret — two callers
 * with the same host identity reuse one SSH connection). Created lazily on first
 * use and released when the last holder calls `release`.
 */
const pool = new Map<string, Pooled>()

// In-flight dials keyed by the same identity. Prevents two concurrent callers
// from opening two separate TCP connections for the same host (the original
// `pool.get` race overwrote the first pooled entry, orphaning its socket).
const pendingDial = new Map<string, Promise<Pooled>>()

function keyOf(host: string, port: number, secret: ResolvedSecret): string {
  return `${host}:${port}:${secret.username}:${secret.password ? "password" : "publicKey"}`
}

/**
 * Handshake budget. 15s proved too tight in the field: cross-network jitter or
 * an sshd momentarily throttling unauthenticated connections (MaxStartups)
 * aborts a dial that would have succeeded seconds later.
 */
const HANDSHAKE_TIMEOUT_MS = 30_000

function dialOnce(host: string, port: number, secret: ResolvedSecret): Promise<Pooled> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    client.on("ready", () => {
      client.sftp((err, sftp) => {
        if (err || !sftp) {
          const msg = errorMessage(err)
          log.error("sftp subsystem error", { host, port, message: msg })
          client.end()
          return reject(new Error(`SFTP subsystem failed on ${host}:${port}: ${msg}`))
        }
        resolve({ client, sftp, refCount: 0 })
      })
    })
    client.on("error", (err) => {
      const msg = errorMessage(err)
      log.error("ssh connection error", { host, port, message: msg, raw: String(err) })
      reject(new Error(`SSH connection to ${host}:${port} failed: ${msg}`))
    })
    client.connect({
      host,
      port,
      username: secret.username,
      password: secret.password,
      privateKey: secret.privateKey,
      passphrase: secret.passphrase,
      readyTimeout: HANDSHAKE_TIMEOUT_MS,
    })
  })
}

/**
 * Dial with one automatic retry for transient failures (handshake timeout,
 * connection reset during banner exchange). Auth failures are NOT retried —
 * a wrong password/key fails deterministically, and retrying it is exactly
 * the pattern that gets an IP banned by fail2ban.
 */
async function dial(host: string, port: number, secret: ResolvedSecret): Promise<Pooled> {
  try {
    return await dialOnce(host, port, secret)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/timed?\s*out|handshake|reset/i.test(msg)) throw err
    log.warn("ssh dial failed transiently, retrying once", { host, port, message: msg })
    return await dialOnce(host, port, secret)
  }
}

export interface LeasedConnection {
  client: Client
  sftp: SFTPWrapper
  /** Release the borrowed connection. Closes the underlying SSH client when the last borrower releases. */
  release: () => void
}

/**
 * Acquire a (possibly reused) SSH/SFTP connection. Reuses an existing pooled
 * connection for the same host identity; otherwise dials a new one. The returned
 * `release` MUST be called exactly once when done — it is safe to call even if
 * the connection was never established (no-op in that case is avoided by the
 * caller's try/finally).
 */
export async function getConnection(
  host: string,
  port: number,
  secret: ResolvedSecret,
): Promise<LeasedConnection> {
  const key = keyOf(host, port, secret)
  const pooled = pool.get(key)
  if (pooled) {
    pooled.refCount += 1
    return { client: pooled.client, sftp: pooled.sftp, release: makeRelease(key) }
  }

  const inFlight = pendingDial.get(key)
  if (inFlight) {
    const p = await inFlight
    p.refCount += 1
    return { client: p.client, sftp: p.sftp, release: makeRelease(key) }
  }

  const dialing = dial(host, port, secret)
    .then((p) => {
      pool.set(key, p)
      return p
    })
    .finally(() => {
      pendingDial.delete(key)
    })
  pendingDial.set(key, dialing)

  const p = await dialing
  p.refCount += 1
  return { client: p.client, sftp: p.sftp, release: makeRelease(key) }
}

function makeRelease(key: string): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    const p = pool.get(key)
    if (!p) return
    p.refCount -= 1
    if (p.refCount <= 0) {
      pool.delete(key)
      p.client.end()
    }
  }
}

// ---------------------------------------------------------------------------
// Directory listing cache: avoids repeated sftp.readdir for the same remote
// path within a short TTL (breadcrumb navigation, re-probes, etc.).
// ---------------------------------------------------------------------------

interface CachedDir {
  entries: import("./sync").RemoteEntry[]
  ts: number
}

const TTL_MS = 30_000
const DIR_CACHE_MAX = 1000
const dirCache = new Map<string, CachedDir>()

function dirKey(host: string, port: number, username: string, auth: string, dir: string): string {
  return `${host}:${port}:${username}:${auth}:${dir}`
}

/** Read the directory cache; returns undefined on miss or expiry. */
export function getCachedDir(
  host: string,
  port: number,
  username: string,
  auth: string,
  dir: string,
): import("./sync").RemoteEntry[] | undefined {
  const k = dirKey(host, port, username, auth, dir)
  const hit = dirCache.get(k)
  if (!hit) return undefined
  if (Date.now() - hit.ts > TTL_MS) {
    dirCache.delete(k)
    return undefined
  }
  return hit.entries
}

/** Store directory entries in the cache. */
export function cacheDir(
  host: string,
  port: number,
  username: string,
  auth: string,
  dir: string,
  entries: import("./sync").RemoteEntry[],
): void {
  const k = dirKey(host, port, username, auth, dir)
  // Bounded cache: evict the oldest entry (Map preserves insertion order) once
  // we exceed the cap. Prevents unbounded growth as the user browses many
  // distinct remote paths. TTL (above) still refreshes hot entries in place.
  if (dirCache.size >= DIR_CACHE_MAX && !dirCache.has(k)) {
    const oldest = dirCache.keys().next().value
    if (oldest !== undefined) dirCache.delete(oldest)
  }
  dirCache.set(k, { entries, ts: Date.now() })
}

/** Drop a single cached directory (e.g. after a mutation at that path). */
export function invalidateDir(
  host: string,
  port: number,
  username: string,
  auth: string,
  dir: string,
): void {
  dirCache.delete(dirKey(host, port, username, auth, dir))
}
