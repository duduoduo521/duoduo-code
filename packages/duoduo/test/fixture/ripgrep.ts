// Mirrors the product-side ripgrep location strategy (src/file/ripgrep.ts):
// 1. `which("rg.exe" | "rg")` — searches PATH **plus** Global.Path.bin
//    (the binary cache the product resolves rg from on every run).
// 2. The product additionally downloads ripgrep from GitHub releases into
//    Global.Path.bin. Tests never download (that would fetch ~10 MB and time out
//    CI/offline runs), so suites stay skipped when neither location has rg.
//
// test/preload.ts redirects XDG_CACHE_HOME to a temp dir so tests never write
// to the real product cache. Reading the real cached binary is read-only and
// safe, and the product runtime resolves rg from that exact directory — so when
// the real cache has rg, we copy it into the (test-isolated) Global.Path.bin.
// This simulates the "download completed" state without network access and lets
// the product Ripgrep layer resolve rg through its normal lookup path.
import fs from "fs"
import os from "os"
import path from "path"
import { Global } from "../../src/global"
import { which } from "../../src/util/which"

function isFile(p: string) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

const exe = process.platform === "win32" ? "rg.exe" : "rg"

// Mirrors the app-name/cache layout of src/global/index.ts (xdg-basedir falls
// back to ~/.cache on Windows where XDG_CACHE_HOME is unset for real runs).
const app = process.env.DUODUO_DEV ? "duoduocode-dev" : "duoduocode"
const realCachedRg = path.join(os.homedir(), ".cache", app, "bin", exe)

export const hasRg = (() => {
  try {
    // 1. Product lookup: PATH + Global.Path.bin (test-isolated under bun preload).
    const found = which(exe)
    if (found && isFile(found)) return true

    // 2. Real product cache: seed the isolated cache so the product layer
    //    resolves rg exactly as it would after its own download.
    if (isFile(realCachedRg)) {
      const dest = path.join(Global.Path.bin, exe)
      if (!isFile(dest)) {
        fs.mkdirSync(Global.Path.bin, { recursive: true })
        fs.copyFileSync(realCachedRg, dest)
      }
      return true
    }
  } catch {
    return false
  }
  return false
})()
