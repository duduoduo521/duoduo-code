import { $ } from "bun"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

// 确保 Bun Shell 的相对路径（如 ../duoduo）基于 packages/desktop 解析
// 而不是基于调用者当前工作目录
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.resolve(__dirname, "..")
process.chdir(DESKTOP_DIR)

import {
  RUST_TARGET,
  copyBinaryToSidecarFolder,
  copySmartLayerToSidecarFolder,
  getCurrentSidecar,
  windowsify,
} from "./utils"

const DUODUO_DIR = path.resolve(DESKTOP_DIR, "../duoduo")
const MONOREPO_ROOT = path.resolve(DESKTOP_DIR, "../..")

// `RUST_TARGET` comes from ./utils on purpose: it is the single source of
// truth (RUST_TARGET ?? TAURI_ENV_TARGET_TRIPLE ?? host triple). Reading the
// environment here as well would let the cargo build target and the sidecar
// file name disagree again.

const sidecarConfig = getCurrentSidecar()

const binaryPath = windowsify(path.resolve(DUODUO_DIR, `dist/${sidecarConfig.ocBinary}/bin/duoduocode`), RUST_TARGET)

// ── Ensure workspace dependencies are installed ──
// Bun workspace may need to resolve dependencies.
// Only run `bun install` if node_modules don't exist yet.
const appNodeModules = path.resolve(MONOREPO_ROOT, "packages/app/node_modules/ghostty-web")
const rootNodeModules = path.resolve(MONOREPO_ROOT, "node_modules")
if (!fs.existsSync(appNodeModules) || !fs.existsSync(rootNodeModules)) {
  console.log("Installing workspace dependencies...")
  try {
    await $`cd ${MONOREPO_ROOT} && bun install`
  } catch (e) {
    console.warn("Root bun install failed (may be GitHub API rate limit):", e)
    console.warn("Continuing with existing node_modules...")
  }
} else {
  console.log("Workspace dependencies already installed, skipping bun install")
}

await (sidecarConfig.ocBinary.includes("-baseline")
  ? $`cd ${DUODUO_DIR} && bun run build --single --baseline --skip-install`
  : $`cd ${DUODUO_DIR} && bun run build --single --skip-install`)

await copyBinaryToSidecarFolder(binaryPath)

// ── Build & copy duo-smart-layer sidecar ──
// 设 DEBUG=1 时用 debug 模式编译，减少 CPU 压力和编译时间
const DEBUG_BUILD = !!process.env.DEBUG
const buildProfile = DEBUG_BUILD ? "debug" : "release"
const smartLayerTargetDir = path.resolve(MONOREPO_ROOT, `target/${RUST_TARGET}/${buildProfile}`)

if (DEBUG_BUILD) {
  await $`cd ${MONOREPO_ROOT} && cargo build -p duo-smart-layer --target ${RUST_TARGET}`
} else {
  await $`cd ${MONOREPO_ROOT} && cargo build --release -p duo-smart-layer --target ${RUST_TARGET}`
}

await copySmartLayerToSidecarFolder(smartLayerTargetDir)

// ── Ensure Tauri bundle license resources (LICENSE / ThirdPartyLicenses.txt) ──
await import("./ensure-license-resources")
