import { test, expect, mock, beforeAll } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { createHash } from "crypto"
import { EventEmitter } from "events"

// ---------------------------------------------------------------------------
// Environment isolation: replace the SSH connection + credential store with
// in-memory fakes so the *real* push/pull conflict state machine in
// `src/remote/sync.ts` runs without a live server. Only `pull`/`push` are
// exercised; `listRemoteDir` (cached-dir branch) is out of scope here.
// ---------------------------------------------------------------------------

class FakeRemote {
  private files = new Map<string, { type: "file" | "dir"; data?: Buffer; mtime: number }>()
  /** Wire-transfer counters, used to assert the skip-if-in-sync optimization. */
  transfers = { fastGet: 0, fastPut: 0 }
  /** Remote paths whose unlink is refused with SFTP status 3 (locked files). */
  private locked = new Set<string>()
  lock(p: string) {
    this.locked.add(p)
  }
  unlock(p: string) {
    this.locked.delete(p)
  }
  /** Absolute paths handed to sftp.mkdir — pins remote-path handling in tests. */
  mkdirCalls: string[] = []
  has(p: string): boolean {
    return this.files.has(p)
  }
  /** Removes a remote file, as a teammate or server-side process would. */
  deleteFile(p: string) {
    this.files.delete(p)
  }
  /**
   * How the fake remote answers `client.exec`:
   *  - "hash"  (default): a working shell with sha256sum.
   *  - "none"           : a shell, but no hashing command available.
   *  - "denied"         : exec refused (e.g. ForceCommand internal-sftp).
   */
  execMode: "hash" | "none" | "denied" = "hash"
  private sec() {
    return Math.floor(Date.now() / 1000)
  }
  setFile(p: string, content: string, mtime = this.sec()) {
    // Synthesize intermediate directory entries so `readdir` mirrors a real
    // remote filesystem (where parent dirs exist independently of files).
    const parts = p.split("/").filter(Boolean)
    let cur = ""
    for (let i = 0; i < parts.length - 1; i++) {
      cur = (cur ? cur + "/" : "/") + parts[i]
      if (!this.files.has(cur)) this.files.set(cur, { type: "dir", mtime: this.sec() })
    }
    this.files.set(p, { type: "file", data: Buffer.from(content), mtime })
  }
  setDir(p: string) {
    this.files.set(p, { type: "dir", mtime: this.sec() })
  }
  get(p: string): string | undefined {
    return this.files.get(p)?.data?.toString("utf-8")
  }
  /** Remote mtime as observed by a post-upload `stat`. */
  mtimeOf(p: string): number | undefined {
    return this.files.get(p)?.mtime
  }
  private attrs(e: { type: "file" | "dir"; data?: Buffer; mtime: number }) {
    return { isDirectory: () => e.type === "dir", mtime: e.mtime, size: e.data?.length ?? 0 }
  }
  sftp() {
    const self = this
    return {
      readdir(remoteDir: string, cb: (err: unknown, list?: unknown[]) => void) {
        const prefix = remoteDir + "/"
        const out: unknown[] = []
        for (const key of self.files.keys()) {
          if (!key.startsWith(prefix)) continue
          const rest = key.slice(prefix.length)
          if (rest.includes("/")) continue // direct children only
          out.push({ filename: rest, longname: "", attrs: self.attrs(self.files.get(key)!) })
        }
        cb(null, out)
      },
      stat(remotePath: string, cb: (err: unknown, attrs?: unknown) => void) {
        const e = self.files.get(remotePath)
        if (!e) {
          const err = new Error("ENOENT: " + remotePath) as NodeJS.ErrnoException
          err.code = "ENOENT"
          return cb(err)
        }
        cb(null, self.attrs(e))
      },
      fastGet(remotePath: string, localPath: string, cb: (err?: unknown) => void) {
        self.transfers.fastGet++
        const e = self.files.get(remotePath)
        if (!e || e.type !== "file") return cb(new Error("not a file: " + remotePath))
        fs.writeFileSync(localPath, e.data!)
        cb()
      },
      fastPut(localPath: string, remotePath: string, cb: (err?: unknown) => void) {
        self.transfers.fastPut++
        const data = fs.readFileSync(localPath)
        // The server writes the file, so its mtime becomes the upload instant —
        // this is what the post-upload re-stat must observe.
        self.files.set(remotePath, { type: "file", data, mtime: self.sec() })
        cb()
      },
      mkdir(remotePath: string, cb: (err?: unknown) => void) {
        self.mkdirCalls.push(remotePath)
        if (self.files.has(remotePath)) {
          // Real-server strictness: mkdir-on-existing fails. Use the nastiest
          // common status — generic SSH_FX_FAILURE (4, message "Failure") —
          // which many servers return instead of FILE_ALREADY_EXISTS (11).
          const err = new Error("Failure") as NodeJS.ErrnoException
          err.code = 4
          return cb(err)
        }
        self.files.set(remotePath, { type: "dir", mtime: self.sec() })
        cb()
      },
      unlink(remotePath: string, cb: (err?: unknown) => void) {
        if (self.locked.has(remotePath)) {
          // Real-server semantics for locked files (e.g. a BT-panel .user.ini):
          // SSH_FX_PERMISSION_DENIED, numeric status 3.
          const err = new Error("Permission denied") as NodeJS.ErrnoException
          err.code = 3
          return cb(err)
        }
        self.files.delete(remotePath)
        cb()
      },
      rmdir(remotePath: string, cb: (err?: unknown) => void) {
        if (self.locked.has(remotePath)) {
          const err = new Error("Permission denied") as NodeJS.ErrnoException
          err.code = 3
          return cb(err)
        }
        self.files.delete(remotePath)
        cb()
      },
    }
  }

  /**
   * Minimal `ssh2.Client` stand-in: only `exec` is exercised, by
   * `remoteContentHashes`. Emits the same `data`/`close` shape the real
   * channel does so the production parser is tested unchanged.
   */
  client() {
    const self = this
    return {
      exec(command: string, cb: (err: Error | undefined, stream?: unknown) => void) {
        if (self.execMode === "denied") {
          cb(new Error("exec request failed on channel"))
          return
        }
        const out = self.execOutput(command)
        if (out === null) {
          cb(new Error("no channel"))
          return
        }
        const stream: any = new EventEmitter()
        stream.stderr = { on: () => {} }
        stream.close = () => {}
        setImmediate(() => {
          stream.emit("data", Buffer.from(out))
          stream.emit("close", 0)
        })
        cb(undefined, stream)
      },
    }
  }

  /** Stands in for `cd root && find . ... -exec sha256sum {} +` on a real host. */
  private execOutput(command: string): string | null {
    if (command.includes("command -v sha256sum")) {
      return this.execMode === "hash" ? "/usr/bin/sha256sum\n" : ""
    }
    if (command.includes("-type d -empty")) {
      // `find . -prune... -type d -empty`: dirs with no children under root,
      // excluding pruned (sync-excluded) subtrees, "./rel" form.
      const root = this.execRoot(command)
      if (root === null) return null
      const out: string[] = []
      for (const [abs, entry] of this.files) {
        if (entry.type !== "dir") continue
        if (!abs.startsWith(root + "/")) continue
        const rel = abs.slice(root.length + 1)
        if (this.isExcluded(rel)) continue
        if ([...this.files.keys()].some((k) => k.startsWith(abs + "/"))) continue
        out.push(`./${rel}`)
      }
      return out.join("\n")
    }
    if (this.execMode === "none") return ""
    const root = this.execRoot(command)
    if (root === null) return null
    const lines: string[] = []
    for (const [abs, entry] of this.files) {
      if (entry.type !== "file") continue
      if (!abs.startsWith(root + "/")) continue
      const rel = abs.slice(root.length + 1)
      if (this.isExcluded(rel)) continue
      lines.push(`${sha256(entry.data!.toString("utf-8"))}  ./${rel}`)
    }
    return lines.join("\n")
  }
  private execRoot(command: string): string | null {
    const match = /^cd '([^']+)'/.exec(command)
    return match ? match[1]! : null
  }
  private isExcluded(rel: string): boolean {
    return rel.split("/").some((part) => DEFAULT_EXCLUDE_NAMES.has(part))
  }
}

/** Mirrors DEFAULT_SYNC_EXCLUDES closely enough for the fake host's pruning. */
const DEFAULT_EXCLUDE_NAMES = new Set(["node_modules", ".git", "dist", "build", ".DS_Store"])

// One in-memory remote per test, shared across the connect() calls inside a
// single pull/push so state seeded by `pull` is visible to a later `push`.
let currentRemote: FakeRemote | undefined
function useRemote(): FakeRemote {
  currentRemote = new FakeRemote()
  return currentRemote
}

mock.module("../../src/remote/connection", () => ({
  getConnection: async (_host: string, _port: number, _secret: unknown) => {
  if (!currentRemote) throw new Error("useRemote() must be called before pull/push")
  return { client: currentRemote.client(), sftp: currentRemote.sftp(), release: () => {} }
  },
  getCachedDir: () => undefined,
  cacheDir: () => {},
  invalidateDir: () => {},
}))
mock.module("../../src/storage/credential", () => ({
  getCredential: () => ({ id: "c", auth: "password", username: "u", secret: "p" }),
}))
mock.module("../../src/storage/remote-mirror", () => ({
  mirrorDir: () => "",
  mirrorStateFile: () => currentStateFile,
}))

let pull: typeof import("../../src/remote/sync").pull
let push: typeof import("../../src/remote/sync").push

beforeAll(async () => {
  const mod = await import("../../src/remote/sync")
  pull = mod.pull
  push = mod.push
})

const STATE_FILE = ".duoduo-sync-state.json"
const PULL_TMP_SUFFIX = ".duoduo-pull-tmp"
function readState(): Record<string, number | string> {
  return JSON.parse(fs.readFileSync(currentStateFile, "utf-8"))
}
function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}
/**
 * Creates a scratch mirror and points `mirrorStateFile()` at a sibling file —
 * the production layout, where sync state sits *beside* the mirror rather than
 * inside it. Tests read it back through `readState()`.
 */
let currentStateFile = ""
function tmpMirror(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duoduo-sync-"))
  currentStateFile = dir + ".state.json"
  return dir
}
const HOST = "test.host"
const PORT = 22
const CRED = "c"
/** Fixed remote mtime (2023-11-14) so tests can assert exact second values. */
const T0 = 1_700_000_000

// ---------------------------------------------------------------------------
// 3a / 3c (pull): records remote mtime (seconds) + content hash for every file
// ---------------------------------------------------------------------------
test("pull writes remote mtime (seconds) and base content hash", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "hello")
  const before = Math.floor(Date.now() / 1000)

  const { conflicts } = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("hello")
  const state = readState()
  expect(state["a.txt"]).toBeGreaterThanOrEqual(before) // remote mtime recorded
  expect(state["a.txt"]).toBeLessThan(1e12) // unit is seconds, not milliseconds (3c)
  expect(state["a.txt__h"]).toBe(sha256("hello")) // base hash seeded (3a)
})

// ---------------------------------------------------------------------------
// 3e (pull): local edit is protected from silent overwrite
// ---------------------------------------------------------------------------
test("pull protects local modification (3e) and force overrides", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A")
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  // Local diverges from the recorded base.
  fs.writeFileSync(path.join(mirror, "a.txt"), "B")

  const noForce = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(noForce.conflicts).toContain("a.txt")
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("B") // local kept (3e)

  const forced = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror, force: true })
  expect(forced.conflicts).toEqual([])
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("A") // force overwrote
})

// ---------------------------------------------------------------------------
// push: the recorded remote mtime must be the one observed AFTER the upload.
// Recording the pre-upload value (the old bug) makes every later sync see a
// bogus "remote changed" and permanently defeats the conflict gate.
// ---------------------------------------------------------------------------
test("push records the remote mtime observed after upload", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(readState()["a.txt"]).toBe(T0)

  fs.writeFileSync(path.join(mirror, "a.txt"), "B")
  const { conflicts } = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(remote.get("/remote/a.txt")).toBe("B")
  const state = readState()
  // Equals the post-upload remote mtime — NOT the pre-upload T0, and never ms.
  expect(state["a.txt"]).toBe(remote.mtimeOf("/remote/a.txt"))
  expect(state["a.txt"] as number).toBeGreaterThan(T0)
  expect(state["a.txt"] as number).toBeLessThan(1e12) // seconds, not ms (3c)
  expect(state["a.txt__h"]).toBe(sha256("B"))
})

// ---------------------------------------------------------------------------
// push idempotence: a second push with no third-party change must be clean.
// This is what breaks if the post-upload re-stat is missing.
// ---------------------------------------------------------------------------
test("repeated push with no remote change stays conflict-free", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  const first = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  const second = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(first.conflicts).toEqual([])
  expect(second.conflicts).toEqual([])
  expect(remote.get("/remote/a.txt")).toBe("A")
})

// ---------------------------------------------------------------------------
// 3d + push gate: remote moved on ⇒ conflict, whether or not the local copy
// changed. Overwriting a remote we never pulled would discard someone else's
// work either way.
// ---------------------------------------------------------------------------
test("push reports conflict when remote changed and local diverged; force bypasses", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror }) // seed base=sha256("A")

  // Remote advances content + mtime; local diverges from base.
  remote.setFile("/remote/a.txt", "A2", T0 + 100)
  fs.writeFileSync(path.join(mirror, "a.txt"), "B")

  const noForce = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(noForce.conflicts).toContain("a.txt")
  expect(remote.get("/remote/a.txt")).toBe("A2") // upload skipped
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("B")

  const forced = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror, force: true })
  expect(forced.conflicts).toEqual([])
  expect(remote.get("/remote/a.txt")).toBe("B") // force uploaded local
})

test("push reports conflict when only the remote changed (local untouched)", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  // Third party rewrites the remote; the local copy is untouched ("A").
  remote.setFile("/remote/a.txt", "REMOTE_EDIT", T0 + 100)

  const { conflicts } = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toContain("a.txt")
  expect(remote.get("/remote/a.txt")).toBe("REMOTE_EDIT") // third-party work preserved
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("A")
})

test("push to a brand-new remote file never conflicts", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/existing.txt", "keep", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  // A file that exists only locally: nothing on the remote to clobber.
  fs.writeFileSync(path.join(mirror, "new.txt"), "fresh")
  const { conflicts } = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(remote.get("/remote/new.txt")).toBe("fresh")
})

test("push refuses to overwrite an unknown remote from a stateless mirror", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "REMOTE", T0)
  fs.writeFileSync(path.join(mirror, "a.txt"), "LOCAL")

  // No sync state at all: the remote content is unknown, so the upload would
  // clobber it. Must conflict instead of fast-forwarding.
  const { conflicts } = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toContain("a.txt")
  expect(remote.get("/remote/a.txt")).toBe("REMOTE")
})

// ---------------------------------------------------------------------------
// pull with no base: content decides — identical ⇒ self-heal, different ⇒
// conflict. This replaces the old "no base ⇒ overwrite" rule that silently
// destroyed local work whenever the state file was lost, corrupt or legacy.
// ---------------------------------------------------------------------------
test("pull self-heals a missing base when local content already matches remote", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  // No state file, but the local copy is byte-identical to the remote.
  fs.writeFileSync(path.join(mirror, "a.txt"), "A")

  const { conflicts } = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  const state = readState()
  expect(state["a.txt__h"]).toBe(sha256("A")) // base seeded ⇒ later syncs are 3-way
  expect(state["a.txt"]).toBe(T0)
  // The comparison temp file must not survive.
  expect(fs.existsSync(path.join(mirror, "a.txt" + PULL_TMP_SUFFIX))).toBe(false)
})

test("pull self-heals a legacy state file that only carried an mtime", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  // Legacy state: mtime present, `__h` companion absent.
  fs.writeFileSync(currentStateFile, JSON.stringify({ "a.txt": T0 }))
  fs.writeFileSync(path.join(mirror, "a.txt"), "A")

  const { conflicts } = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(readState()["a.txt__h"]).toBe(sha256("A"))
})

test("pull reports conflict when no base exists and local content differs", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "REMOTE", T0)
  // Untracked local work with no base to compare against.
  fs.writeFileSync(path.join(mirror, "a.txt"), "MY_LOCAL_WORK")

  const noForce = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(noForce.conflicts).toContain("a.txt")
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("MY_LOCAL_WORK") // not clobbered
  expect(fs.existsSync(path.join(mirror, "a.txt" + PULL_TMP_SUFFIX))).toBe(false)

  const forced = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror, force: true })
  expect(forced.conflicts).toEqual([])
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("REMOTE")
  expect(readState()["a.txt__h"]).toBe(sha256("REMOTE"))
})

test("pull still compares content when sizes match but bytes differ", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  // Equal length, different bytes: the size pre-check cannot decide this one, so
  // the temp-file comparison has to run.
  remote.setFile("/remote/a.txt", "BBBB", T0)
  fs.writeFileSync(path.join(mirror, "a.txt"), "AAAA")

  const { conflicts } = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toContain("a.txt")
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("AAAA")
  expect(fs.existsSync(path.join(mirror, "a.txt" + PULL_TMP_SUFFIX))).toBe(false)
})

// ---------------------------------------------------------------------------
// §9 invariant: content-identical file is never reported as a conflict even
// when the remote mtime advanced (only mtime changed, content same).
// ---------------------------------------------------------------------------
test("content-identical remote update yields no conflict", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A")
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  // Remote mtime advances but content stays "A".
  remote.setFile("/remote/a.txt", "A", Math.floor(Date.now() / 1000) + 100)
  fs.writeFileSync(path.join(mirror, "a.txt"), "A") // local identical

  const { conflicts } = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(conflicts).toEqual([])
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("A")
})

// ---------------------------------------------------------------------------
// Multiple diverged files are all reported in a single run.
// ---------------------------------------------------------------------------
test("pull reports every diverged file in one pass", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  remote.setFile("/remote/b.txt", "B", T0)
  remote.setFile("/remote/c.txt", "C", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  fs.writeFileSync(path.join(mirror, "a.txt"), "A-local")
  fs.writeFileSync(path.join(mirror, "c.txt"), "C-local")

  const { conflicts } = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect([...conflicts].sort()).toEqual(["a.txt", "c.txt"])
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("A-local")
  expect(fs.readFileSync(path.join(mirror, "b.txt"), "utf-8")).toBe("B") // untouched file still pulled
})

// ---------------------------------------------------------------------------
// Nested directories: pull/push recurse and key state by relative path.
// ---------------------------------------------------------------------------
test("pull/push recurse into nested directories", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/sub/deep.txt", "nested")

  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(fs.readFileSync(path.join(mirror, "sub", "deep.txt"), "utf-8")).toBe("nested")
  const state = readState()
  expect(state["sub/deep.txt__h"]).toBe(sha256("nested"))

  // Round-trip from a fresh mirror: it must pull first — with no state the
  // remote content is unknown, so a blind push has to conflict.
  const mirror2 = tmpMirror()
  fs.mkdirSync(path.join(mirror2, "sub"), { recursive: true })
  fs.writeFileSync(path.join(mirror2, "sub", "deep.txt"), "nested")
  const blind = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror: mirror2 })
  expect(blind.conflicts).toContain("sub/deep.txt")
  expect(remote.get("/remote/sub/deep.txt")).toBe("nested")

  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror: mirror2 })
  const { conflicts } = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror: mirror2 })
  expect(conflicts).toEqual([])
  expect(readState()["sub/deep.txt__h"]).toBe(sha256("nested"))
})

// ---------------------------------------------------------------------------
// mkdirRemote regressions: absolute remote paths must stay absolute (a
// relative "remote/…" would silently create junk under the SFTP home
// directory), and mkdir-on-existing must be tolerated because many servers
// answer it with generic SSH_FX_FAILURE (4, message "Failure") instead of
// FILE_ALREADY_EXISTS (11) — the failure that surfaced to users as a bare
// "Failed to push to remote: Failure".
// ---------------------------------------------------------------------------
test("push into a pre-existing remote subdirectory survives mkdir FAILURE(4)", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/sub/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  fs.writeFileSync(path.join(mirror, "sub", "a.txt"), "B")
  const { conflicts } = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(remote.get("/remote/sub/a.txt")).toBe("B")
  // Absolute remote paths stay absolute — mkdir was asked for the real path.
  expect(remote.mkdirCalls).toContain("/remote/sub")
  // …and no relative junk was created under the SFTP home.
  expect(remote.has("remote/sub")).toBe(false)
})

test("push creates brand-new remote subdirectories at the absolute path", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  fs.mkdirSync(path.join(mirror, "new", "deep"), { recursive: true })
  fs.writeFileSync(path.join(mirror, "new", "deep", "x.txt"), "x")
  const { conflicts } = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(remote.get("/remote/new/deep/x.txt")).toBe("x")
  expect(remote.has("new")).toBe(false)
})

// ---------------------------------------------------------------------------
// Deletion propagation: a file deleted locally (state remembers it) must be
// unlinked on the remote instead of surviving forever. Gates mirror the upload
// path: remote-only files (no state) are never deleted, and a remote file that
// changed since the last sync is a conflict, not a silent clobber.
// ---------------------------------------------------------------------------
test("push propagates a local deletion and forgets the state entry", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  fs.rmSync(path.join(mirror, "a.txt"))
  const { conflicts } = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(remote.get("/remote/a.txt")).toBeUndefined()
  const state = readState()
  expect(state["a.txt"]).toBeUndefined()
  expect(state["a.txt__h"]).toBeUndefined()

  // Idempotent: a second push with the file still gone stays clean.
  const again = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(again.conflicts).toEqual([])
})

test("push refuses to delete a remote file that changed since the last sync; force deletes", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  // A teammate edited the remote; locally the file was deleted.
  remote.setFile("/remote/a.txt", "EDITED_ELSEWHERE", T0 + 100)
  fs.rmSync(path.join(mirror, "a.txt"))

  const noForce = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(noForce.conflicts).toContain("a.txt")
  expect(remote.get("/remote/a.txt")).toBe("EDITED_ELSEWHERE") // third-party work kept
  expect(readState()["a.txt"]).toBe(T0) // state kept so the conflict stays visible

  const forced = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror, force: true })
  expect(forced.conflicts).toEqual([])
  expect(remote.get("/remote/a.txt")).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Permission-locked remote files (BT-panel .user.ini chattr +i et al.): the
// unlink is refused with SFTP status 3. The push must NOT die for it — the
// file lands in `skipped`, other deletions/uploads still run, and the state
// entries stay so the deletion is retried once the lock is removed.
// ---------------------------------------------------------------------------
test("push skips a permission-locked remote file instead of failing the whole push", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/.user.ini", "lock", T0)
  remote.setFile("/remote/b.txt", "B", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  fs.rmSync(path.join(mirror, ".user.ini"))
  fs.rmSync(path.join(mirror, "b.txt"))
  remote.lock("/remote/.user.ini")

  const { conflicts, skipped } = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(skipped).toEqual([".user.ini"])
  expect(remote.get("/remote/.user.ini")).toBe("lock") // locked file survives remotely
  expect(readState()[".user.ini"]).toBeDefined() // stays tracked for a later retry
  expect(remote.get("/remote/b.txt")).toBeUndefined() // other deletions still propagated

  // Once the server-side lock is gone, the next push finishes the deletion.
  remote.unlock("/remote/.user.ini")
  const again = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(again.skipped).toEqual([])
  expect(again.conflicts).toEqual([])
  expect(remote.get("/remote/.user.ini")).toBeUndefined()
  expect(readState()[".user.ini"]).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Ghost directories: the remote FILES of a deleted subtree unlink fine, but
// the remote DIRECTORY itself can be impossible to rmdir (BT-panel site root
// owned by `www` — status 3). The prune used to swallow that silently, and
// the next pull re-created the empty dir locally as a shell (which the next
// push then mkdirRemote'd straight back). Now the unremovable dir is reported
// in `skipped` (with a trailing "/"), and pull no longer materializes empty
// remote directories locally.
// ---------------------------------------------------------------------------
test("push reports a remote directory it cannot remove; pull does not resurrect it as an empty shell", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/code/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  fs.rmSync(path.join(mirror, "code"), { recursive: true })
  remote.lock("/remote/code") // rmdir refused (site root permission), unlink ok

  const { conflicts, skipped } = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(conflicts).toEqual([])
  expect(skipped).toEqual(["code/"]) // reported, not silent
  expect(remote.get("/remote/code/a.txt")).toBeUndefined() // files did go away
  expect(remote.has("/remote/code")).toBe(true) // only the empty dir remains

  // Pull must NOT recreate the local shell for the remote empty dir.
  const { conflicts: c2 } = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(c2).toEqual([])
  expect(fs.existsSync(path.join(mirror, "code"))).toBe(false)

  // Self-heal: once the server-side lock is gone, the sweep on the NEXT push
  // removes the leftover empty dir even though this push deleted nothing.
  remote.unlock("/remote/code")
  const final = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(final.skipped).toEqual([])
  expect(remote.has("/remote/code")).toBe(false)
})

test("pull creates local directories only for subtrees that contain files", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setDir("/remote/empty")
  remote.setDir("/remote/deep/empty")
  remote.setFile("/remote/deep/real.txt", "R", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(fs.existsSync(path.join(mirror, "empty"))).toBe(false)
  expect(fs.existsSync(path.join(mirror, "deep", "real.txt"))).toBe(true)
  expect(fs.existsSync(path.join(mirror, "deep", "empty"))).toBe(false)
})

// ---------------------------------------------------------------------------
// Ghost-dir self-heal sweep: EMPTY remote dirs whose local counterpart is gone
// are removed by the next push (iterated bottom-up), so a failed historical
// prune cannot keep resurrecting folders on every pull. Dirs that still exist
// locally (live content) are never swept, and failures land in `skipped`.
// ---------------------------------------------------------------------------
test("push sweeps away empty remote dirs that have no local counterpart", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/app/index.html", "<html>", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  // Ghosts left by an earlier failed prune (multi-level: needs 2 rounds), plus
  // an empty dir that DOES exist locally (must be kept).
  remote.setDir("/remote/ghost/deep")
  remote.setDir("/remote/keep")
  fs.mkdirSync(path.join(mirror, "keep"))

  const { skipped } = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(skipped).toEqual([])
  expect(remote.has("/remote/ghost")).toBe(false) // whole chain collapsed
  expect(remote.has("/remote/keep")).toBe(true) // live locally — kept
  expect(remote.has("/remote/app")).toBe(true) // real content untouched
  expect(remote.get("/remote/app/index.html")).toBe("<html>")
})

test("deleting a local subtree prunes the emptied remote directories", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/sub/deep.txt", "nested", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  fs.rmSync(path.join(mirror, "sub"), { recursive: true })
  const { conflicts } = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(remote.get("/remote/sub/deep.txt")).toBeUndefined()
  expect(remote.has("/remote/sub")).toBe(false)
})

test("a remote-only file with no state entry is never deleted", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  // Appears on the remote after the pull: no state entry, provenance unknown.
  remote.setFile("/remote/teammate.txt", "X", T0 + 5)
  fs.rmSync(path.join(mirror, "a.txt"))

  const { conflicts } = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(remote.get("/remote/teammate.txt")).toBe("X")
  expect(remote.get("/remote/a.txt")).toBeUndefined() // own deletion propagated
  expect(conflicts).toEqual([]) // remote-only file is pull's business, not push's
})

// ---------------------------------------------------------------------------
// Deletion propagation, pull direction: a file deleted on the server (state
// remembers it) must be removed from the mirror too — but only when the local
// copy is untouched; unsynced local work is a conflict, not a clobber.
// ---------------------------------------------------------------------------
test("pull propagates a remote deletion when the local copy is untouched", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  remote.deleteFile("/remote/a.txt")
  const { conflicts } = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(fs.existsSync(path.join(mirror, "a.txt"))).toBe(false)
  const state = readState()
  expect(state["a.txt"]).toBeUndefined()
  expect(state["a.txt__h"]).toBeUndefined()

  // Idempotent: a second pull with the file still gone stays clean.
  const again = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(again.conflicts).toEqual([])
})

test("pull keeps locally modified work when the remote deletes it; force deletes", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  // The server deleted the file while the local copy carried unsynced work.
  remote.deleteFile("/remote/a.txt")
  fs.writeFileSync(path.join(mirror, "a.txt"), "MY_LOCAL_WORK")

  const noForce = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(noForce.conflicts).toContain("a.txt")
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("MY_LOCAL_WORK") // kept
  expect(readState()["a.txt"]).toBe(T0) // state kept so the conflict stays visible

  const forced = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror, force: true })
  expect(forced.conflicts).toEqual([])
  expect(fs.existsSync(path.join(mirror, "a.txt"))).toBe(false)
})

test("pull deletion detection falls back to stat when the remote cannot hash", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.execMode = "none" // no shell access ⇒ remoteContentHashes returns null
  remote.setFile("/remote/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  remote.deleteFile("/remote/a.txt")
  const { conflicts } = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(fs.existsSync(path.join(mirror, "a.txt"))).toBe(false)
  expect(readState()["a.txt"]).toBeUndefined()
})

test("a remotely deleted subtree prunes the emptied local directories", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/sub/deep.txt", "nested", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  remote.deleteFile("/remote/sub/deep.txt")
  // A real `rm -r` on the server also removes the directory itself.
  await new Promise<void>((r) => remote.sftp().rmdir("/remote/sub", () => r()))
  const { conflicts } = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(fs.existsSync(path.join(mirror, "sub", "deep.txt"))).toBe(false)
  expect(fs.existsSync(path.join(mirror, "sub"))).toBe(false)
})

test("an emptied remote directory does not resurrect locally as an empty shell", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/sub/deep.txt", "nested", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  // Only the file was deleted on the server; the (now empty) directory stayed.
  remote.deleteFile("/remote/sub/deep.txt")
  const { conflicts } = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(fs.existsSync(path.join(mirror, "sub", "deep.txt"))).toBe(false)
  // Empty remote dirs are not mirrored — a leftover "ghost" dir must not
  // reappear in the tree on every pull.
  expect(fs.existsSync(path.join(mirror, "sub"))).toBe(false)
})

// ---------------------------------------------------------------------------
// Excluded entries (dependencies / build output / VCS metadata) never traverse
// the wire — they dominate file count for nothing, and `.git` can be corrupted
// by a partial transfer.
// ---------------------------------------------------------------------------
test("pull skips excluded entries", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  remote.setFile("/remote/node_modules/dep/index.js", "dep", T0)
  remote.setFile("/remote/dist/bundle.js", "bundle", T0)
  remote.setFile("/remote/.git/config", "cfg", T0)
  remote.setFile("/remote/src/deep/node_modules/x.js", "x", T0)

  const { conflicts } = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("A")
  expect(fs.existsSync(path.join(mirror, "node_modules"))).toBe(false)
  expect(fs.existsSync(path.join(mirror, "dist"))).toBe(false)
  expect(fs.existsSync(path.join(mirror, ".git"))).toBe(false)
  // Exclusion matches by base name at any depth.
  expect(fs.existsSync(path.join(mirror, "src", "deep", "node_modules"))).toBe(false)
  // `src` holds no non-excluded files, so it never materializes locally.
  expect(fs.existsSync(path.join(mirror, "src"))).toBe(false)
})

test("push skips excluded entries", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  fs.mkdirSync(path.join(mirror, "node_modules"), { recursive: true })
  fs.writeFileSync(path.join(mirror, "node_modules", "dep.js"), "dep")
  fs.writeFileSync(path.join(mirror, "a.txt"), "A")

  const { conflicts } = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(remote.get("/remote/a.txt")).toBe("A")
  expect(remote.get("/remote/node_modules/dep.js")).toBeUndefined()
})

test("exclude is overridable per call", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/node_modules/dep/index.js", "dep", T0)

  // Passing an explicit list replaces the default, so nothing is skipped.
  const { conflicts } = await pull({
    host: HOST,
    port: PORT,
    remotePath: "/remote",
    credentialRef: CRED,
    mirror,
    exclude: [],
  })

  expect(conflicts).toEqual([])
  expect(fs.readFileSync(path.join(mirror, "node_modules", "dep", "index.js"), "utf-8")).toBe("dep")
})

// ---------------------------------------------------------------------------
// The mirror is what the user sees as their project: only remote content may
// appear in it. Sync state lives beside the mirror, never inside.
// ---------------------------------------------------------------------------
test("sync state is written outside the mirror directory", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)

  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(fs.readdirSync(mirror)).toEqual(["a.txt"])
  expect(fs.existsSync(currentStateFile)).toBe(true)
  expect(path.dirname(currentStateFile)).not.toBe(mirror)
})

test("a state file left inside the mirror by an older version is removed", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  fs.writeFileSync(path.join(mirror, STATE_FILE), "{}")

  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(fs.existsSync(path.join(mirror, STATE_FILE))).toBe(false)
  expect(fs.readdirSync(mirror)).toEqual(["a.txt"])
})

// ---------------------------------------------------------------------------
// Obsolete `duoduo` marker. Project discovery used to read the id back out of a
// file dropped in the mirror; it now reads the database, so any surviving marker
// is dead weight that would also be uploaded to the server (leaking host/port/
// path). A user file that merely shares the name must be left alone.
// ---------------------------------------------------------------------------
test("push drops an obsolete marker instead of uploading it", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  fs.writeFileSync(path.join(mirror, "index.html"), "<html></html>")
  fs.writeFileSync(path.join(mirror, "duoduo"), "remote:c29tZS1wcm9qZWN0LWlk")

  const { conflicts } = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(remote.get("/remote/index.html")).toBe("<html></html>")
  expect(fs.existsSync(path.join(mirror, "duoduo"))).toBe(false)
  expect(remote.get("/remote/duoduo")).toBeUndefined()
})

test("pull removes an obsolete marker left over from an older version", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/index.html", "<html></html>", T0)
  fs.writeFileSync(path.join(mirror, "duoduo"), "remote:c29tZS1wcm9qZWN0LWlk")

  const { conflicts } = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(fs.existsSync(path.join(mirror, "duoduo"))).toBe(false)
})

test("a user file named duoduo is left alone", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  fs.writeFileSync(path.join(mirror, "duoduo"), "my own file")

  const { conflicts } = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(fs.existsSync(path.join(mirror, "duoduo"))).toBe(true)
  expect(remote.get("/remote/duoduo")).toBe("my own file")
})

// ---------------------------------------------------------------------------
// Hashing streams in 1 MiB chunks; a file spanning several of them (and ending
// mid-chunk) must hash exactly like a one-shot digest.
// ---------------------------------------------------------------------------
test("hashes files larger than the internal chunk size", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  // 3 MiB + an odd tail: forces multiple full chunks and a partial final one.
  const big = "x".repeat(3 * 1024 * 1024) + "tail"
  remote.setFile("/remote/big.bin", big, T0)

  const { conflicts } = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  expect(conflicts).toEqual([])
  expect(fs.readFileSync(path.join(mirror, "big.bin"), "utf-8")).toBe(big)
  expect(readState()["big.bin__h"]).toBe(sha256(big))
})

// ---------------------------------------------------------------------------
// Skip-if-in-sync: when both ends still match the recorded base (mtime+size
// quick check), pull/push must not transfer the same bytes again. The state
// already carries (remote mtime, base hash) precisely so this question is
// answerable without touching the wire.
// ---------------------------------------------------------------------------
test("repeated sync with no changes transfers nothing", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)

  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(remote.transfers.fastGet).toBe(1) // first pull downloads

  const p1 = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(p1.conflicts).toEqual([])
  expect(remote.transfers.fastPut).toBe(0) // already in sync ⇒ no upload

  const p2 = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(p2.conflicts).toEqual([])
  expect(remote.transfers.fastPut).toBe(0)
  expect(remote.get("/remote/a.txt")).toBe("A")

  const pull2 = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(pull2.conflicts).toEqual([])
  expect(remote.transfers.fastGet).toBe(1) // second pull skipped the download
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("A")
})

test("skip-if-in-sync never masks a real change", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  // Local edit ⇒ push must upload even though the previous sync was clean.
  fs.writeFileSync(path.join(mirror, "a.txt"), "B")
  const pushed = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(pushed.conflicts).toEqual([])
  expect(remote.transfers.fastPut).toBe(1)
  expect(remote.get("/remote/a.txt")).toBe("B")

  // Remote edit ⇒ pull must download even though the previous sync was clean.
  remote.setFile("/remote/a.txt", "A2", T0 + 100)
  const pulled = await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(pulled.conflicts).toEqual([])
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("A2")
  expect(remote.transfers.fastGet).toBe(2)
})

test("push force always uploads even when nothing appears to have changed", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  // force means "overwrite remote with local" — the user's explicit choice must
  // bypass the in-sync shortcut.
  const forced = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror, force: true })
  expect(forced.conflicts).toEqual([])
  expect(remote.transfers.fastPut).toBe(1)
  expect(remote.get("/remote/a.txt")).toBe("A")
})

// ---------------------------------------------------------------------------
// Documented limit of the (mtime, size) quick check. Locked down by test so the
// boundary is not re-investigated from scratch: the remote side is identified by
// (mtime, size) alone, because SFTP exposes no content checksum over the wire.
// ---------------------------------------------------------------------------
test("remote hashing catches a same-second same-length remote rewrite", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "AAAA", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(remote.transfers.fastGet).toBe(1)

  // Rewritten to different content with the SAME length in the SAME second the
  // sync recorded: (mtime, size) cannot see this. The remote sha256 listing can.
  remote.setFile("/remote/a.txt", "BBBB", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(remote.transfers.fastGet).toBe(2) // downloaded — no longer missed
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("BBBB")
})

test("push sees a same-second same-length remote rewrite via remote hashing", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "AAAA", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  // Local untouched, remote rewritten same-second/same-length. Push must not
  // skip the upload on the strength of (mtime, size) alone.
  remote.setFile("/remote/a.txt", "BBBB", T0)
  const pushed = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(pushed.conflicts).toEqual([])
  expect(remote.transfers.fastPut).toBe(1)
  expect(remote.get("/remote/a.txt")).toBe("AAAA")
})

// ── Fallback: the remote cannot hash ──────────────────────────────────────
// Both failure modes must degrade to the pre-existing (mtime, size) behaviour,
// never to "assume unchanged" (which would miss MORE than the heuristic).
test("exec denied falls back to (mtime,size) without regressing", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.execMode = "denied"
  remote.setFile("/remote/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(remote.transfers.fastGet).toBe(1)

  const p = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(p.conflicts).toEqual([])
  expect(remote.transfers.fastPut).toBe(0) // unchanged ⇒ still skipped
  expect(remote.get("/remote/a.txt")).toBe("A")
})

test("no hashing command on the remote falls back to (mtime,size)", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.execMode = "none"
  remote.setFile("/remote/a.txt", "A", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })

  const p = await push({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(p.conflicts).toEqual([])
  expect(remote.transfers.fastPut).toBe(0) // unchanged ⇒ still skipped
})

test("a length change is never missed, even within the same second", async () => {
  const mirror = tmpMirror()
  const remote = useRemote()
  remote.setFile("/remote/a.txt", "AAAA", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(remote.transfers.fastGet).toBe(1)

  // Same second as the recorded mtime, but a different byte length ⇒ caught.
  remote.setFile("/remote/a.txt", "BBBBB", T0)
  await pull({ host: HOST, port: PORT, remotePath: "/remote", credentialRef: CRED, mirror })
  expect(remote.transfers.fastGet).toBe(2)
  expect(fs.readFileSync(path.join(mirror, "a.txt"), "utf-8")).toBe("BBBBB")
})
