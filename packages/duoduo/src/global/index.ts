import fs from "fs/promises"
import { execFile } from "child_process"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import path from "path"
import os from "os"
import { Effect, Layer } from "effect"
import { Filesystem } from "../util"
import { Flock } from "@duoduo-ai/shared/util/flock"
// Single source of truth for the `@duoduo/Global` service CLASS. The class is
// defined in `@duoduo-ai/shared/global`; every consumer (app-runtime, npm,
// bootstrap, ...) MUST reference that exact same class, otherwise Effect's
// context lookup fails with "Service not found: @duoduo/Global" (it matches by
// class identity, not by the string id). We re-use `SharedGlobal.Service` here
// instead of re-declaring a new `Context.Service`, and only supply the
// desktop-specific path values via our own `layer`.
import { Global as SharedGlobal } from "@duoduo-ai/shared/global"

const app = process.env.DUODUO_DEV ? "duoduocode-dev" : "duoduocode"

// xdg-basedir returns undefined on Windows where XDG dirs don't exist.
// Fall back to platform-standard directories.
const isWindows = process.platform === "win32"

const localAppData = isWindows ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local") : undefined

const appData = isWindows ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming") : undefined

const data = path.join(xdgData ?? localAppData ?? path.join(os.homedir(), ".local", "share"), app)
const cache = path.join(
  xdgCache ?? (localAppData ? path.join(localAppData, "Cache") : undefined) ?? path.join(os.homedir(), ".cache"),
  app,
)
const config = path.join(xdgConfig ?? appData ?? path.join(os.homedir(), ".config"), app)
const state = path.join(xdgState ?? localAppData ?? path.join(os.homedir(), ".local", "state"), app)

export const Path = {
  // Allow override via DUODUO_TEST_HOME for test isolation
  get home() {
    return process.env.DUODUO_TEST_HOME || os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  gears: path.join(data, "gears"),
  cache,
  config,
  state,
}

// ─────────────────────────────────────────────────────────────────────────────
// `Global` (effect service + value namespace) is defined HERE, BEFORE the
// top-level `await`s below. `global/index.ts` has top-level awaits (fs.mkdir,
// cache-version check). Because ESM uses live bindings, any module that imports
// `Global` and constructs a Layer at load time (e.g. app-runtime's `AppLayer`)
// would observe `Global.Service` / `Global.layer` as UNDEFINED if this namespace
// were declared after those awaits — producing "Service not found: @duoduo/Global"
// at runtime. Defining it synchronously, up front, avoids that race entirely.
//
// Single source of truth for the `@duoduo/Global` service CLASS. The class is
// defined in `@duoduo-ai/shared/global`; every consumer (app-runtime, npm,
// bootstrap, ...) MUST reference that exact same class, otherwise Effect's
// context lookup fails with "Service not found: @duoduo/Global" (it matches by
// class identity, not by the string id). We re-use `SharedGlobal.Service` here
// instead of re-declaring a new `Context.Service`, and only supply the
// desktop-specific path values via our own `layer`. Every
// `import { Global } from "../global"` / "@/global" and `@duoduo-ai/shared/global`
// then resolves to the SAME class.
const GlobalPath = Path

export namespace Global {
  export const Service = SharedGlobal.Service

  export interface Interface extends SharedGlobal.Interface {}

  export const layer = Layer.effect(
    Service,
    Effect.sync(() =>
      Service.of({
        home: Path.home,
        data: Path.data,
        cache: Path.cache,
        config: Path.config,
        state: Path.state,
        bin: Path.bin,
        log: Path.log,
        gears: Path.gears,
      }),
    ),
  )

  // Keep `Global.Path` working for the many value consumers.
  export const Path = GlobalPath
}

// Initialize Flock with global state path
Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
])

// Read-only ACL probe. `icacls <dir>` with no arguments only reads the directory's
// own DACL: O(1), measured 37-39ms regardless of tree size. The
// `/inheritance:r /grant:r` write pass is O(files) — 5138ms for a 12,624-file data
// dir — so probing first keeps the write pass off the startup path on every run
// where the ACL is already hardened (and off it permanently as the tree grows).
//
// Failure closes toward re-hardening: a spawn error or empty output yields "", so
// the caller applies the restriction instead of skipping it.
//
// Verified against real icacls output:
//   inherited -> "NT AUTHORITY\SYSTEM:(I)(OI)(CI)(F)"  (contains "(I)")          -> false
//   hardened  -> "OUT\user:(OI)(CI)(F)"                (no "(I)", grant matches) -> true
// The two checks fail closed independently: "(OI)(CI)(F)" never contains the
// substring "(I)", and the inherited form inserts "(I)" between the account and
// "(OI)", so the grant substring cannot match there either.
async function aclHardened(dir: string, username: string): Promise<boolean> {
  const output = await new Promise<string>((resolve) => {
    execFile("icacls", [dir], { windowsHide: true }, (err, stdout) => resolve(err ? "" : stdout))
  })
  let granted = false
  for (const line of output.split(/\r?\n/)) {
    if (line.includes("(I)")) return false
    if (line.includes(`${username}:(OI)(CI)(F)`)) granted = true
  }
  return granted
}

// On Windows, restrict the data/config/state directories to the current user only.
// NTFS doesn't support Unix mode bits (chmod 0o600 is a no-op), so we use icacls
// to remove inherited permissions and grant full control exclusively to the
// current user. Failure is non-fatal — the directories still work, just without
// the extra ACL hardening.
if (isWindows) {
  const username = process.env.USERNAME
  if (username) {
    const dirsToProtect = [Path.data, Path.config, Path.state]
    for (const dir of dirsToProtect) {
      try {
        if (await aclHardened(dir, username)) continue
        await new Promise<void>((resolve, reject) => {
          execFile(
            "icacls",
            [dir, "/inheritance:r", "/grant:r", `${username}:(OI)(CI)F`],
            { windowsHide: true },
            (err) => (err ? reject(err) : resolve()),
          )
        })
      } catch (e: any) {
        // Non-fatal: directory is still functional, just without ACL restriction.
        console.warn(`[security] icacls failed for ${dir}: ${e?.message ?? e}`)
      }
    }
  } else {
    console.warn("[security] USERNAME env var is empty — cannot set ACL restrictions on data directories")
  }
}

const CACHE_VERSION = "21"

const version = await Filesystem.readText(path.join(Path.cache, "version")).catch(() => "0")

if (version !== CACHE_VERSION) {
  try {
    const contents = await fs.readdir(Path.cache)
    await Promise.all(
      contents.map((item) =>
        fs.rm(path.join(Path.cache, item), {
          recursive: true,
          force: true,
        }),
      ),
    )
  } catch {}
  await Filesystem.write(path.join(Path.cache, "version"), CACHE_VERSION)
}


