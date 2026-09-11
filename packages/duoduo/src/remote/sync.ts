import { Client, type SFTPWrapper } from "ssh2"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "fs"
import { createHash } from "crypto"
import path from "path"
import { mirrorDir, mirrorStateFile } from "../storage/remote-mirror"
import { getCredential } from "../storage/credential"
import { KEY_DIR } from "../storage/credential-crypto"
import { Log } from "../util"
import { errorMessage } from "../util/error"
import { getConnection, getCachedDir, cacheDir } from "./connection"
import { remoteContentHashes, remoteListEmptyDirs } from "./remote-hash"

const log = Log.create({ service: "remote-sync" })

const STATE_FILE = ".duoduo-sync-state.json"

/**
 * pull 在缺少 base 记录、需要与本地逐字节比对时使用的临时文件后缀。
 * 放在目标文件同目录，保证同一文件系统（无需跨设备拷贝）。
 */
const PULL_TMP_SUFFIX = ".duoduo-pull-tmp"

/** Delete a temp file, ignoring any failure — cleanup must never break a sync. */
function rmQuietly(p: string): void {
  try {
    rmSync(p, { force: true })
  } catch {
    // ignore
  }
}

/**
 * Obsolete project-marker file.
 *
 * Older versions wrote `<mirror>/duoduo` holding the project id, because project
 * discovery used to read the id back out of that file. Discovery now resolves the
 * id from the database (`worktree` === mirror path), so the file is dead weight —
 * and because sync never excluded it, every push uploaded it to the server,
 * exposing the host, SSH port and absolute remote path.
 *
 * Removed on every sync so already-connected mirrors self-clean. The content
 * check keeps us from deleting a user file that merely shares the name.
 */
function removeLegacyMarker(mirror: string): void {
  const marker = path.join(mirror, "duoduo")
  if (!existsSync(marker)) return
  try {
    if (readFileSync(marker, "utf-8").startsWith("remote:")) rmQuietly(marker)
  } catch {
    // Unreadable, or not ours — leave it alone.
  }
}

/**
 * Attach the failing operation, remote path and (when the server provides one)
 * an SFTP status hint to a raw transport error. Without this the route surfaces
 * the server's bare one-word message ("Failure") and neither the user nor the
 * log can tell which file or which operation died.
 */
function wrapSftpError(op: string, remotePath: string, localPath: string | undefined, err: unknown): Error {
  const base = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: unknown } | null)?.code
  const status = typeof code === "number" ? ` [SFTP status ${code}]` : ""
  const hint =
    code === 3
      ? " — permission denied (check remote path ownership/permissions)"
      : code === 4
        ? " — server refused the operation (often no write permission, disk full or quota exceeded)"
        : code === 11
          ? " — target already exists"
          : ""
  const local = localPath ? ` (local "${localPath}")` : ""
  return new Error(`${op} failed for remote "${remotePath}"${local}: ${base}${status}${hint}`)
}

/**
 * Cap on concurrent SFTP file transfers. push/pull previously issued one
 * fastGet/fastPut per file simultaneously; a tree with thousands of files piled
 * hundreds of concurrent requests onto a single SFTP channel, which several
 * server implementations answer with a generic SSH_FX_FAILURE. 8 concurrent
 * transfers keeps one channel comfortably busy.
 */
const TRANSFER_CONCURRENCY = 8

let activeTransfers = 0
const transferQueue: (() => void)[] = []

async function withTransferSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeTransfers >= TRANSFER_CONCURRENCY) {
    await new Promise<void>((wake) => transferQueue.push(wake))
  }
  activeTransfers++
  try {
    return await fn()
  } finally {
    activeTransfers--
    transferQueue.shift()?.()
  }
}

/** fastGet with a bounded-concurrency slot. Errors are wrapped by the caller. */
function fastGet(sftp: SFTPWrapper, remotePath: string, localPath: string): Promise<void> {
  return withTransferSlot(
    () =>
      new Promise<void>((res, rej) => {
        sftp.fastGet(remotePath, localPath, (e) => (e ? rej(e) : res()))
      }),
  )
}

/** fastPut with a bounded-concurrency slot. Errors are wrapped by the caller. */
function fastPut(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return withTransferSlot(
    () =>
      new Promise<void>((res, rej) => {
        sftp.fastPut(localPath, remotePath, (e) => (e ? rej(e) : res()))
      }),
  )
}

/**
 * Read/hash chunk size: big enough to amortise syscalls, small enough that a
 * multi-GB file never turns into a multi-GB allocation.
 */
const HASH_CHUNK = 1024 * 1024

/**
 * SHA-256 of file contents, used for content-level (not mtime-only) conflict
 * detection.
 *
 * Streamed in fixed-size chunks rather than `readFileSync`, which allocates the
 * entire file: syncing a 2 GB model weight would otherwise spike the sidecar's
 * RSS by 2 GB (measured: +200 MB RSS for a 200 MB file, +0 streamed). Memory is
 * now flat regardless of file size.
 */
function sha256File(p: string): string {
  const hash = createHash("sha256")
  const fd = openSync(p, "r")
  try {
    const buf = Buffer.allocUnsafe(HASH_CHUNK)
    let read = 0
    while ((read = readSync(fd, buf, 0, HASH_CHUNK, null)) > 0) {
      hash.update(buf.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest("hex")
}

/**
 * Does the local file carry changes that were never synced?
 *
 * Only answerable when a base hash exists. A missing base (first sync, state
 * file lost/corrupt, or a legacy file that only carried an mtime) proves
 * nothing: the local copy may be an untouched download or unsynced work. Callers
 * must handle that case separately (see `pullDir`, which compares byte-for-byte)
 * instead of assuming "no base ⇒ no local change" and silently overwriting.
 */
function hasLocalChanges(baseHash: string | undefined, localHash: string): boolean {
  return baseHash !== undefined && localHash !== baseHash
}

interface ResolvedSecret {
  username: string
  password?: string
  privateKey?: Buffer
  passphrase?: string
}

export function resolveSecret(credentialRef: string): ResolvedSecret {
  const cred = getCredential(credentialRef)
  if (!cred) throw new Error(`credential not found: ${credentialRef}`)
  if (cred.auth === "password") {
    return { username: cred.username, password: cred.secret }
  }
  const keyPath = path.join(KEY_DIR, `${cred.id}.key`)
  return {
    username: cred.username,
    privateKey: existsSync(keyPath) ? readFileSync(keyPath) : undefined,
    passphrase: cred.secret || undefined,
  }
}

/**
 * Acquire a (cached) SSH/SFTP connection. Replaced the old one-shot dial with a
 * pooled lease so browsing, probing and pulling reuse a single connection per
 * host identity. Callers must release via the returned `release` (the `finally`
 * blocks below were updated from `client.end()` to `release()`).
 */
async function connect(
  host: string,
  port: number,
  secret: ResolvedSecret,
): Promise<{ client: Client; sftp: SFTPWrapper; release: () => void }> {
  const leased = await getConnection(host, port, secret)
  return { client: leased.client, sftp: leased.sftp, release: leased.release }
}

/**
 * relPath → remote mtime (seconds, number), plus `<rel>__h` → base content hash
 * (string). Both live in one JSON object, hence the union value type.
 */
type State = Record<string, number | string>
function loadState(stateFile: string): State {
  if (!existsSync(stateFile)) return {}
  try {
    return JSON.parse(readFileSync(stateFile, "utf-8")) as State
  } catch {
    return {}
  }
}
function saveState(stateFile: string, state: State): void {
  writeFileSync(stateFile, JSON.stringify(state), "utf-8")
}

/**
 * State files used to live at `<mirror>/.duoduo-sync-state.json`. Older mirrors
 * still carry one; it is superseded by `mirrorStateFile()` and would otherwise
 * linger in the user's project tree (and needed excluding from every upload).
 */
function removeLegacyStateFile(mirror: string): void {
  rmQuietly(path.join(mirror, STATE_FILE))
}

/**
 * Directory / file names that are never synced.
 *
 * Dependency trees, build output, caches and VCS metadata dominate the file
 * count of a typical project — syncing them costs bandwidth and time for nothing
 * — and transferring `.git` can leave the remote repository corrupted.
 *
 * Matching is by base name at any depth, so `a/node_modules` and `a/b/build` are
 * both skipped. Override per call with the `exclude` option.
 */
export const DEFAULT_SYNC_EXCLUDES = [
  // VCS metadata
  ".git",
  ".svn",
  ".hg",
  // Dependencies
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  // Build output
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  // Caches & test artifacts
  ".cache",
  ".turbo",
  ".parcel-cache",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  // OS junk
  ".DS_Store",
  "Thumbs.db",
]

/**
 * Recursively pull `remotePath` from the remote host into the local mirror.
 * Records each file's remote mtime and content hash into the sync-state file
 * for later conflict detection on push.
 */
export async function pull(input: {
  host: string
  port: number
  remotePath: string
  credentialRef: string
  mirror: string
  force?: boolean
  exclude?: string[]
  /** Overrides the sync-state location; defaults to `mirrorStateFile()`. */
  stateFile?: string
}): Promise<{ conflicts: string[] }> {
  const mirror = input.mirror || mirrorDir(input.host, input.remotePath)
  const stateFile = input.stateFile ?? mirrorStateFile(input.host, input.remotePath)
  if (!existsSync(mirror)) mkdirSync(mirror, { recursive: true })
  removeLegacyMarker(mirror)
  removeLegacyStateFile(mirror)
  const secret = resolveSecret(input.credentialRef)
  const { client, sftp, release } = await connect(input.host, input.port, secret)
  const state = loadState(stateFile)
  const conflicts: string[] = []
  const exclude = new Set(input.exclude ?? DEFAULT_SYNC_EXCLUDES)
  try {
    // One exec for the whole tree: lets pull compare the remote side by CONTENT
    // instead of by (mtime, size), which cannot see a same-second, same-length
    // rewrite. null = remote cannot provide them -> pullDir falls back.
    const hashes = await remoteContentHashes({
      client,
      root: input.remotePath.replace(/\/+$/, ""),
      exclude,
    })
    // Remote deletions must propagate to the mirror too, or files deleted on
    // the server would survive locally forever. Runs before pullDir so the
    // state is clean and freed local directories are gone before pullDir
    // recreates any same-named remote content.
    const deleted = await pullDeletions(
      sftp,
      mirror,
      input.remotePath.replace(/\/+$/, ""),
      state,
      conflicts,
      input.force ?? false,
      hashes,
    )
    pruneEmptyLocalDirs(mirror, deleted)
    await pullDir(
      sftp,
      input.remotePath.replace(/\/+$/, ""),
      mirror,
      state,
      "",
      conflicts,
      input.force ?? false,
      exclude,
      hashes,
    )
  } finally {
    // Persist whatever completed before an error (a partially synced tree still
    // has valid per-file records), but never let a save failure skip `release`.
    try {
      saveState(stateFile, state)
    } finally {
      release()
    }
  }
  return { conflicts }
}

function pullDir(
  sftp: SFTPWrapper,
  remoteDir: string,
  localDir: string,
  state: State,
  prefix: string,
  conflicts: string[],
  force: boolean,
  exclude: Set<string>,
  hashes: Map<string, string> | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.readdir(remoteDir, (err, list) => {
      if (err) return reject(wrapSftpError("read directory", remoteDir, undefined, err))
      Promise.all(
        list.map((entry) => {
          const rel = entry.filename
          if (exclude.has(rel)) return Promise.resolve()
          const remotePath = `${remoteDir}/${rel}`
          const localPath = path.join(localDir, rel)
          const relKey = prefix ? `${prefix}/${rel}` : rel
          return new Promise<void>((res, rej) => {
            sftp.stat(remotePath, (e, st) => {
              if (e) return rej(wrapSftpError("stat", remotePath, undefined, e))
              if (st.isDirectory()) {
                // No eager local mkdir: a remote directory that is (or only
                // contains) excluded content must NOT materialize as an empty
                // local shell. Files create their parent chain on demand in the
                // file branch, so only subtrees with actual content appear.
                pullDir(sftp, remotePath, localPath, state, relKey, conflicts, force, exclude, hashes).then(res, rej)
              } else {
                if (!existsSync(localDir)) mkdirSync(localDir, { recursive: true })
                const localExists = existsSync(localPath)
                const baseHash = state[relKey] !== undefined ? readBaseHash(state, relKey) : undefined
                if (localExists && !force) {
                  const localHash = sha256File(localPath)
                  if (baseHash === undefined) {
                    // Cheap pre-check: differing sizes prove differing content, so
                    // the conflict can be reported without transferring the file.
                    if (statSync(localPath).size !== st.size) {
                      conflicts.push(relKey)
                      return res() // keep local
                    }
                    // No base recorded (first sync / state file lost or corrupt /
                    // legacy state that only carried an mtime). We cannot prove the
                    // local copy holds no unsynced work, so download to a sibling
                    // temp file and compare content instead of overwriting blindly:
                    // identical ⇒ nothing to lose, adopt the remote mtime and seed
                    // the base (self-heal); different ⇒ report a conflict and keep
                    // the local file.
                    const tmp = localPath + PULL_TMP_SUFFIX
                    return void fastGet(sftp, remotePath, tmp)
                      .then(() => {
                        try {
                          const remoteHash = sha256File(tmp)
                          if (remoteHash !== localHash) {
                            conflicts.push(relKey) // keep local
                          } else {
                            state[relKey] = st.mtime
                            writeBaseHash(state, relKey, remoteHash)
                          }
                          res()
                        } finally {
                          rmQuietly(tmp)
                        }
                      })
                      .catch((te: unknown) => {
                        rmQuietly(tmp)
                        rej(wrapSftpError("download", remotePath, tmp, te))
                      })
                  }
                  // Conflict gate: local content diverged from the recorded base ⇒
                  // unsynced local work. Report it rather than overwrite. The old
                  // `remoteChanged` (mtime) precondition is deliberately gone: a
                  // local edit must be protected even when the remote did NOT
                  // change (3e).
                  if (hasLocalChanges(baseHash, localHash)) {
                    conflicts.push(relKey)
                    return res() // keep local, skip fastGet
                  }
                  // Already in sync: local matches the recorded base, and — when
                  // the remote could hash its own tree — the remote content
                  // still equals that same base, so re-downloading would
                  // transfer identical bytes for nothing.
                  if (remoteMatchesBase(hashes, relKey, baseHash)) {
                    return res()
                  }
                  // Fallback when the remote gave us no hashes (no exec
                  // permission, no sha256sum/shasum, timeout): rsync-style
                  // size+mtime quick check. It cannot see a rewrite that lands
                  // in the same second AND yields the same byte length, because
                  // SFTP exposes mtime with 1s granularity and no content
                  // checksum — that gap is exactly what `hashes` closes above.
                  if (hashes === null && st.mtime === readMtime(state, relKey) && st.size === statSync(localPath).size) {
                    return res()
                  }
                }
                fastGet(sftp, remotePath, localPath)
                  .then(() => {
                    state[relKey] = st.mtime
                    writeBaseHash(state, relKey, sha256File(localPath))
                    res()
                  })
                  .catch((fe: unknown) => rej(wrapSftpError("download", remotePath, localPath, fe)))
              }
            })
          })
        }),
      )
        .then(() => resolve())
        .catch(reject)
    })
  })
}

/**
 * The sync state maps relPath → remote mtime (number). To enable content-level
 * conflict detection we also persist a content hash for the base under a
 * companion key `<rel>__h`. Falls back to undefined when absent (legacy state).
 */
function readBaseHash(state: State, relKey: string): string | undefined {
  const value = state[`${relKey}__h`]
  return typeof value === "string" ? value : undefined
}
function writeBaseHash(state: State, relKey: string, hash: string): void {
  state[`${relKey}__h`] = hash
}

/**
 * Whether the remote content of `rel` still equals the recorded base, answered
 * from the remote's own sha256 listing (see `remote-hash.ts`).
 *
 * Returns false whenever the answer is unknown — no listing, no entry for this
 * path, or no recorded base — so callers fall back to the (mtime, size) quick
 * check rather than skipping a transfer they could not justify.
 */
function remoteMatchesBase(
  hashes: Map<string, string> | null,
  rel: string,
  baseHash: string | undefined,
): boolean {
  if (!hashes || baseHash === undefined) return false
  return hashes.get(rel) === baseHash
}

/** Recorded remote mtime in seconds. Absent / corrupt entries read as 0. */
function readMtime(state: State, relKey: string): number {
  const value = state[relKey]
  return typeof value === "number" ? value : 0
}

/**
 * Recursively create a remote directory (ssh2's sftp.mkdir has no `recursive`).
 *
 * Two real-server behaviours this must survive:
 *  - Absolute remote paths keep their leading "/" (split/filter alone turned
 *    "/remote/sub" into the relative "remote/sub", silently creating junk
 *    under the SFTP home directory).
 *  - Servers disagree on the status code for mkdir-on-existing: OpenSSH
 *    reports FILE_ALREADY_EXISTS (11), but many implementations answer with
 *    generic SSH_FX_FAILURE (4, message "Failure"). ssh2's err.code is the
 *    numeric SFTP status — never the string "EEXIST" an earlier check compared
 *    against — so instead of guessing from the code, confirm with a stat.
 */
function mkdirRemote(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  const parts = remotePath.split("/").filter(Boolean)
  const prefix = remotePath.startsWith("/") ? "/" : ""
  return new Promise((resolve, reject) => {
    let cur = ""
    const step = (i: number) => {
      if (i >= parts.length) return resolve()
      cur = cur ? `${cur}/${parts[i]}` : `${prefix}${parts[i]}`
      sftp.mkdir(cur, (e) => {
        if (!e) return step(i + 1)
        // The directory may already exist; verify instead of trusting the
        // status code the server chose for it.
        sftp.stat(cur, (se, st) => {
          if (!se && st && st.isDirectory()) return step(i + 1)
          reject(wrapSftpError("mkdir", cur, undefined, e))
        })
      })
    }
    step(0)
  })
}

/**
 * Push local mirror changes back to the remote.
 */
export async function push(input: {
  host: string
  port: number
  remotePath: string
  credentialRef: string
  mirror: string
  force?: boolean
  exclude?: string[]
  /** Overrides the sync-state location; defaults to `mirrorStateFile()`. */
  stateFile?: string
}): Promise<{ conflicts: string[]; skipped: string[] }> {
  const mirror = input.mirror || mirrorDir(input.host, input.remotePath)
  const stateFile = input.stateFile ?? mirrorStateFile(input.host, input.remotePath)
  removeLegacyMarker(mirror)
  removeLegacyStateFile(mirror)
  const secret = resolveSecret(input.credentialRef)
  const { client, sftp, release } = await connect(input.host, input.port, secret)
  const state = loadState(stateFile)
  const baseRemote = input.remotePath.replace(/\/+$/, "")
  const conflicts: string[] = []
  const skipped: string[] = []
  const exclude = new Set(input.exclude ?? DEFAULT_SYNC_EXCLUDES)
  try {
    // Local deletions must propagate BEFORE the upload pass: a locally deleted
    // file may have been replaced by a same-named directory (the remote file
    // must be gone before mkdirRemote runs), and files deleted together with
    // their subtree free remote directories for the empty-dir prune below.
    const deleted = await pushDeletions(sftp, mirror, baseRemote, state, conflicts, skipped, input.force ?? false)
    const unremovedDirs = await pruneEmptyRemoteDirs(sftp, mirror, baseRemote, deleted)
    // Trailing "/" marks a DIRECTORY the remote refused to drop.
    skipped.push(...unremovedDirs.map((d) => `${d}/`))
    // See `pull`: compare the remote side by content when the remote can hash
    // its own tree; otherwise pushDir falls back to (mtime, size).
    const hashes = await remoteContentHashes({ client, root: baseRemote, exclude })
    await pushDir(sftp, mirror, baseRemote, "", state, conflicts, input.force ?? false, exclude, hashes)
    await sweepEmptyRemoteDirs({ client, sftp, root: baseRemote, mirror, exclude, skipped })
  } finally {
    // See `pull`: keep the files already uploaded, and never skip `release`.
    try {
      saveState(stateFile, state)
    } finally {
      release()
    }
  }
  return { conflicts, skipped: [...new Set(skipped)] }
}

/**
 * Self-healing sweep for "ghost" remote directories. An earlier deletion whose
 * directory prune failed (the failure used to be silent) leaves EMPTY dirs on
 * the server; the next pull mirrors them back to the local tree as empty
 * shells, so deleted folders keep "coming back". This pass lists the remote's
 * completely-empty dirs with one `find -type d -empty` exec and removes those
 * whose local counterpart is gone, iterating a few rounds because removing
 * leaves empties out their ancestors.
 *
 * Safety: only dirs that are TRULY empty server-side and absent locally are
 * removed — anything containing files (tracked, excluded or unknown) is never
 * touched. Failures are reported in `skipped` (with a trailing "/"), they do
 * not fail the push. A null listing (no exec permission etc.) just skips the
 * sweep.
 */
async function sweepEmptyRemoteDirs(input: {
  client: Client
  sftp: SFTPWrapper
  root: string
  mirror: string
  exclude: Set<string>
  skipped: string[]
}): Promise<void> {
  for (let round = 0; round < 5; round++) {
    const emptyDirs = await remoteListEmptyDirs({ client: input.client, root: input.root, exclude: input.exclude })
    if (!emptyDirs || emptyDirs.length === 0) return
    const deepestFirst = emptyDirs.sort((a, b) => b.split("/").length - a.split("/").length)
    let progress = false
    for (const dir of deepestFirst) {
      if (existsSync(path.join(input.mirror, dir))) continue // live locally — keep remote
      const removed = await new Promise<boolean>((res) => {
        input.sftp.rmdir(`${input.root}/${dir}`, (err) => {
          if (err) {
            input.skipped.push(`${dir}/`)
            log.warn("sweepEmptyRemoteDirs: rmdir failed", {
              remoteDir: `${input.root}/${dir}`,
              message: err instanceof Error ? err.message : String(err),
            })
          }
          res(!err)
        })
      })
      if (removed) progress = true
    }
    if (!progress) return
  }
}

/**
 * Propagate local deletions to the remote.
 *
 * `pushDir` only uploads what still exists locally, so a file deleted in the
 * mirror used to survive on the server forever. A deletion is recognisable
 * because the sync state remembers every synced file: a state entry (mtime key)
 * whose local file is gone means the local side deleted it. The remote copy is
 * then unlinked and the state entries (mtime + base hash) dropped, so later
 * syncs treat the file as never having existed.
 *
 * Safety gates mirror the upload path:
 *  - No state entry ⇒ unknown provenance: never deleted (a remote-only file
 *    created by a teammate must surface as a pull conflict, not vanish).
 *  - Remote mtime moved past the recorded one ⇒ someone else changed it since
 *    the last sync; deleting would discard their work. Report a conflict and
 *    keep both sides; `force` overrides.
 *  - Local path replaced by a DIRECTORY with the same name ⇒ the remote file
 *    must go so `mkdirRemote` can create the directory (counted as a deletion).
 *  - Permission denied (SFTP status 3) ⇒ the file is reported in `skipped`
 *    and the push continues. Hosts like BT panels lock files (e.g. `.user.ini`
 *    with chattr +i) that the SSH user can never delete; failing the whole
 *    push for them made every sync of such a project error out. The state
 *    entries are kept so the file stays tracked and the deletion is retried
 *    once the server-side lock is removed.
 *
 * Returns the relative paths actually deleted (or already absent remotely) so
 * the caller can prune emptied remote directories.
 */
async function pushDeletions(
  sftp: SFTPWrapper,
  mirror: string,
  baseRemote: string,
  state: State,
  conflicts: string[],
  skipped: string[],
  force: boolean,
): Promise<string[]> {
  const deleted: string[] = []
  for (const key of Object.keys(state)) {
    if (key.endsWith("__h") || typeof state[key] !== "number") continue
    const localPath = path.join(mirror, key)
    let locallyGone = !existsSync(localPath)
    if (!locallyGone && statSync(localPath).isDirectory()) locallyGone = true // file→dir replacement
    if (!locallyGone) continue
    const remotePath = `${baseRemote}/${key}`
    await new Promise<void>((res, rej) => {
      sftp.stat(remotePath, (err, rstat) => {
        if (err) {
          if (sftpStatusCode(err) === 3) {
            // stat itself refused (permission): the file may still exist, so it
            // must NOT be treated as already-gone — skip and keep it tracked.
            skipped.push(key)
            log.warn("pushDeletions: stat permission denied, skipping", { remotePath })
            return res()
          }
          // Remote already gone (deleted on the server side): just forget it.
          delete state[key]
          delete state[`${key}__h`]
          deleted.push(key)
          return res()
        }
        if (!force && rstat.mtime > readMtime(state, key)) {
          conflicts.push(key)
          return res() // third-party work — keep remote, keep state
        }
        sftp.unlink(remotePath, (ue) => {
          if (ue) {
            if (sftpStatusCode(ue) === 3) {
              // Locked / no permission (e.g. BT-panel .user.ini). Keep the push
              // alive, keep the state so the file stays tracked and surfaces
              // again once the lock is gone.
              skipped.push(key)
              log.warn("pushDeletions: unlink permission denied, skipping", { remotePath })
              return res()
            }
            return rej(wrapSftpError("delete", remotePath, undefined, ue))
          }
          delete state[key]
          delete state[`${key}__h`]
          deleted.push(key)
          res()
        })
      })
    })
  }
  return deleted
}

/** SFTP status code of a raw ssh2 error, if the server provided one. */
function sftpStatusCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === "number" ? code : undefined
}

/**
 * Best-effort removal of remote directories that a deletion emptied. Only
 * directories on the path of actually-deleted files are considered, the local
 * counterpart must still be gone, and the remote directory must read as empty —
 * anything else (still-has-files, excluded leftovers like node_modules,
 * permission errors) leaves the directory in place. Deepest first, so a whole
 * locally-deleted subtree collapses bottom-up in one pass.
 *
 * Returns the relative paths of directories that STILL exist remotely (either
 * non-empty or the rmdir was refused — e.g. a BT-panel site root owned by
 * `www`, so the SSH user cannot rmdir its children). The caller surfaces them
 * in `skipped` instead of failing the push; without the report these
 * "ghost" empty dirs were silently resurrected by the next pull.
 */
async function pruneEmptyRemoteDirs(
  sftp: SFTPWrapper,
  mirror: string,
  baseRemote: string,
  deleted: string[],
): Promise<string[]> {
  const unremoved: string[] = []
  const dirs = new Set<string>()
  for (const rel of deleted) {
    const parts = rel.split("/").slice(0, -1)
    let cur = ""
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part
      dirs.add(cur)
    }
  }
  const deepestFirst = [...dirs].sort((a, b) => b.split("/").length - a.split("/").length)
  for (const dir of deepestFirst) {
    if (existsSync(path.join(mirror, dir))) continue // recreated locally — keep it
    const remoteDir = `${baseRemote}/${dir}`
    await new Promise<void>((res) => {
      sftp.readdir(remoteDir, (err, list) => {
        if (err) {
          // ENOENT-style absence is fine (already gone); anything else
          // (permission) means we cannot even inspect it — report.
          const sc = sftpStatusCode(err)
          if (sc !== 2 && sc !== 10) unremoved.push(dir)
          return res() // not empty / gone / unreadable: leave it
        }
        if (!list || list.length > 0) {
          unremoved.push(dir) // still has files (e.g. excluded leftovers) — report
          return res()
        }
        sftp.rmdir(remoteDir, (re) => {
          if (re) unremoved.push(dir) // refused (permission) — report, don't fail
          res()
        })
      })
    })
  }
  return unremoved
}

/**
 * Propagate remote deletions to the local mirror (the pull counterpart of
 * `pushDeletions`).
 *
 * A state entry (mtime key) whose file is absent from the remote tree was
 * deleted on the server. Detection uses the remote hash listing when available
 * (one exec for the whole tree, exact); without one (no exec permission) it
 * falls back to a per-key stat — codes 2/10 mean gone, anything else is treated
 * as "cannot tell" and left alone.
 *
 * Safety gates mirror pushDeletions, on the local side:
 *  - The local file is only removed when its content still matches the recorded
 *    base hash — unsynced local work is kept and reported as a conflict.
 *  - A missing base (state lost / legacy) is unknown provenance ⇒ conflict.
 *  - `force` overrides and deletes regardless.
 *  - A local file that is already gone just drops its stale state entries.
 *
 * Returns the relative paths removed so the caller can prune emptied local
 * directories.
 */
async function pullDeletions(
  sftp: SFTPWrapper,
  mirror: string,
  remoteRoot: string,
  state: State,
  conflicts: string[],
  force: boolean,
  hashes: Map<string, string> | null,
): Promise<string[]> {
  const deleted: string[] = []
  for (const key of Object.keys(state)) {
    if (key.endsWith("__h") || typeof state[key] !== "number") continue
    const localPath = path.join(mirror, key)
    if (!existsSync(localPath)) {
      // Already gone locally (deleted by hand?): just forget the stale entry.
      delete state[key]
      delete state[`${key}__h`]
      continue
    }
    let remoteGone: boolean
    if (hashes) {
      remoteGone = !hashes.has(key)
    } else {
      remoteGone = await new Promise<boolean>((res) => {
        sftp.stat(`${remoteRoot}/${key}`, (err) => {
          const code = (err as { code?: unknown } | null)?.code
          // 2 NO_SUCH_FILE / 10 NO_SUCH_PATH; "ENOENT" covers local-style fakes.
          res(err !== undefined && (code === 2 || code === 10 || code === "ENOENT"))
        })
      })
    }
    if (!remoteGone) continue
    if (!force) {
      const baseHash = readBaseHash(state, key)
      if (baseHash === undefined || sha256File(localPath) !== baseHash) {
        conflicts.push(key)
        continue // unsynced local work or unknown provenance — keep it
      }
    }
    try {
      rmSync(localPath, { force: true })
    } catch {
      // Locked / unremovable: keep the state so the next sync retries.
    }
    if (existsSync(localPath)) continue
    delete state[key]
    delete state[`${key}__h`]
    deleted.push(key)
  }
  return deleted
}

/**
 * Best-effort removal of local directories emptied by propagated deletions.
 * Only directories on the path of actually-deleted files are considered and
 * only when they read as empty — anything else keeps the directory. Deepest
 * first, so a remotely-deleted subtree collapses bottom-up in one pass.
 */
function pruneEmptyLocalDirs(mirror: string, deleted: string[]): void {
  const dirs = new Set<string>()
  for (const rel of deleted) {
    const parts = rel.split("/").slice(0, -1)
    let cur = ""
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part
      dirs.add(cur)
    }
  }
  const deepestFirst = [...dirs].sort((a, b) => b.split("/").length - a.split("/").length)
  for (const dir of deepestFirst) {
    const full = path.join(mirror, dir)
    try {
      // rmdirSync only ever removes an EMPTY directory — exactly the contract;
      // anything non-empty (or locked) throws and is left in place.
      rmdirSync(full)
    } catch {
      // Not empty, locked, or unreadable — leave it in place.
    }
  }
}

/**
 * Recursively delete `remotePath` (and everything under it) on the remote host.
 * Irreversible — only invoked when the user explicitly opts into deleting the
 * remote files (a second, independent confirmation beyond disconnecting).
 */
export async function removeRemote(input: {
  host: string
  port: number
  remotePath: string
  credentialRef: string
}): Promise<void> {
  const secret = resolveSecret(input.credentialRef)
  const { client, sftp, release } = await connect(input.host, input.port, secret)
  try {
    await removeRemoteDir(sftp, input.remotePath.replace(/\/+$/, ""))
  } finally {
    release()
  }
}

function removeRemoteDir(sftp: SFTPWrapper, remoteDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.readdir(remoteDir, (err, list) => {
      if (err) return reject(wrapSftpError("read directory", remoteDir, undefined, err))
      Promise.all(
        list.map((entry) => {
          const remotePath = `${remoteDir}/${entry.filename}`
          return new Promise<void>((res, rej) => {
            sftp.stat(remotePath, (e, st) => {
              if (e) return rej(wrapSftpError("stat", remotePath, undefined, e))
              if (st.isDirectory()) {
                removeRemoteDir(sftp, remotePath)
                  .then(
                    () =>
                      new Promise<void>((r, j) =>
                        sftp.rmdir(remotePath, (re) => (re ? j(wrapSftpError("remove directory", remotePath, undefined, re)) : r())),
                      ),
                  )
                  .then(res, rej)
              } else {
                sftp.unlink(remotePath, (ue) => (ue ? rej(wrapSftpError("delete", remotePath, undefined, ue)) : res()))
              }
            })
          })
        }),
      )
        .then(() =>
          new Promise<void>((r, j) =>
            sftp.rmdir(remoteDir, (re) => (re ? j(wrapSftpError("remove directory", remoteDir, undefined, re)) : r())),
          ),
        )
        .then(resolve)
        .catch(reject)
    })
  })
}

export interface RemoteEntry {
  name: string
  type: "directory" | "file"
  size: number
  mtime: number
}

/**
 * List a single directory on the remote host. Used by the remote-project
 * picker so the user can browse the server instead of typing a path blind.
 *
 * Connects directly from the supplied connection options (bypassing the
 * credential store) so browsing works before the project is connected/saved.
 * Both directories and files are returned (directories sorted first), and the
 * result is cached per remote path for a short TTL so breadcrumb navigation and
 * connection probes do not re-read the directory. The connection is released
 * afterwards (returned to the pool, closed only when no other caller holds it).
 */
export async function listRemoteDir(input: {
  host: string
  port: number
  username?: string
  auth: "password" | "publicKey"
  secret: string
  privateKey?: string
  dir: string
}): Promise<RemoteEntry[]> {
  const cached = getCachedDir(input.host, input.port, input.username ?? "", input.auth, input.dir || ".")
  if (cached) return cached
  const secret: ResolvedSecret = {
    username: input.username ?? "",
    password: input.auth === "password" ? input.secret : undefined,
    privateKey: input.auth === "publicKey" && input.privateKey ? Buffer.from(input.privateKey) : undefined,
    passphrase: input.auth === "publicKey" ? input.secret || undefined : undefined,
  }
  const { client, sftp, release } = await connect(input.host, input.port, secret)
  try {
    const target = input.dir || "."
    const entries = await new Promise<RemoteEntry[]>((resolve, reject) => {
      sftp.readdir(target, (err, list) => {
        if (err) {
          const msg = errorMessage(err)
          log.error("sftp readdir error", { host: input.host, port: input.port, dir: target, message: msg })
          return reject(new Error(`Failed to list "${target}" on ${input.host}:${input.port}: ${msg}`))
        }
        const result: RemoteEntry[] = list
          .map((e) => ({
            name: e.filename,
            type: (e.attrs.isDirectory() ? "directory" : "file") as "directory" | "file",
            size: Number(e.attrs.size ?? 0),
            mtime: Number(e.attrs.mtime ?? 0),
          }))
          .sort((a, b) => {
            // Directories first, then alphabetical within each group.
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1
            return a.name.localeCompare(b.name)
          })
        resolve(result)
      })
    })
    cacheDir(input.host, input.port, input.username ?? "", input.auth, target, entries)
    return entries
  } finally {
    release()
  }
}

function pushDir(
  sftp: SFTPWrapper,
  localDir: string,
  remoteDir: string,
  prefix: string,
  state: State,
  conflicts: string[],
  force: boolean,
  exclude: Set<string>,
  hashes: Map<string, string> | null,
): Promise<void> {
  // Exclude the sync state file, any leftover pull temp files (a crashed pull
  // could leave one behind; it is not user content and must never be uploaded),
  // and the dependency / build / VCS entries listed in DEFAULT_SYNC_EXCLUDES.
  const entries = readdirSync(localDir).filter(
    (n) => n !== STATE_FILE && !n.endsWith(PULL_TMP_SUFFIX) && !exclude.has(n),
  )
  return Promise.all(
    entries.map((name) => {
      const localPath = path.join(localDir, name)
      const remotePath = `${remoteDir}/${name}`
      const rel = prefix ? `${prefix}/${name}` : name
      const st = statSync(localPath)
      if (st.isDirectory()) {
        // An empty local directory is not content — never mkdirRemote it.
        // Without this, an unremovable remote dir resurrected locally by a
        // pull (empty shell) would be pushed straight back to the server.
        if (readdirSync(localPath).length === 0) return Promise.resolve()
        return mkdirRemote(sftp, remotePath).then(() =>
          pushDir(sftp, localPath, remotePath, rel, state, conflicts, force, exclude, hashes),
        )
      }
      return pushSingle(sftp, localPath, remotePath, rel, state, conflicts, force, hashes)
    }),
  ).then(() => {})
}

/** Push a single file, refusing to clobber a remote that moved since the last sync. */
function pushSingle(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  rel: string,
  state: State,
  conflicts: string[],
  force: boolean,
  hashes: Map<string, string> | null,
): Promise<void> {
  const localHash = sha256File(localPath)
  const baseHash = readBaseHash(state, rel)
  return new Promise<void>((res, rej) => {
    sftp.stat(remotePath, (err, rstat) => {
      // `state[rel]` is the remote mtime observed when the last sync FINISHED, so
      // a strictly newer value means the remote moved on since then (another
      // machine, a teammate, an editor on the server). Uploading would discard
      // that content whether or not the local copy also changed — so report a
      // conflict and let the user pick a direction (force). A missing remote file
      // (stat error) has nothing to clobber and uploads freely.
      const remoteChanged = !err && rstat.mtime > readMtime(state, rel)
      if (remoteChanged && !force) {
        conflicts.push(rel)
        return res() // skip upload, let caller surface conflict
      }
      // Already in sync: local matches the recorded base, and — when the remote
      // could hash its own tree — the remote content still equals that same
      // base, so re-uploading would send identical bytes for nothing.
      // `!err` keeps the recreate-missing-remote-file path intact and `!force`
      // lets an explicit "overwrite remote" always go through.
      if (!err && !force && localHash === baseHash && remoteMatchesBase(hashes, rel, baseHash)) {
        return res()
      }
      // Fallback without remote hashes: rsync-style size+mtime quick check, with
      // the same 1-second-granularity blind spot described in `pullDir`.
      if (
        hashes === null &&
        !err &&
        !force &&
        localHash === baseHash &&
        rstat.mtime === readMtime(state, rel) &&
        rstat.size === statSync(localPath).size
      ) {
        return res()
      }
      fastPut(sftp, localPath, remotePath)
        .then(
          () =>
            new Promise<void>((res2, rej2) => {
              // Re-stat after the upload. `fastPut` lets the server write the file, so
              // its mtime becomes the upload instant — NOT the value observed above.
              // Recording that stale pre-upload value would make every later sync see a
              // bogus "remote changed" and defeat the gate above.
              sftp.stat(remotePath, (se, after) => {
                // A failed re-stat degrades to 0, which makes the next sync report a
                // conflict (safe side) instead of silently overwriting.
                state[rel] = se ? 0 : after!.mtime
                writeBaseHash(state, rel, localHash)
                res2()
              })
            }),
        )
        .then(() => res())
        .catch((fe: unknown) => rej(wrapSftpError("upload", remotePath, localPath, fe)))
    })
  })
}
