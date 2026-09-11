import { $ } from "bun"
import * as path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.resolve(__dirname, "..")
const SIDEARS_DIR = path.resolve(DESKTOP_DIR, "src-tauri/sidecars")

export const SIDECAR_BINARIES: Array<{ rustTarget: string; ocBinary: string; assetExt: string }> = [
  {
    rustTarget: "aarch64-apple-darwin",
    ocBinary: "duoduo-darwin-arm64",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-apple-darwin",
    ocBinary: "duoduo-darwin-x64",
    assetExt: "zip",
  },
  {
    rustTarget: "aarch64-pc-windows-msvc",
    ocBinary: "duoduo-windows-arm64",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-pc-windows-msvc",
    ocBinary: "duoduo-windows-x64",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-pc-windows-gnu",
    ocBinary: "duoduo-windows-x64",
    assetExt: "zip",
  },
  {
    rustTarget: "x86_64-unknown-linux-gnu",
    ocBinary: "duoduo-linux-x64",
    assetExt: "tar.gz",
  },
  {
    rustTarget: "aarch64-unknown-linux-gnu",
    ocBinary: "duoduo-linux-arm64",
    assetExt: "tar.gz",
  },
]

/** Rust target triple of the machine running the script. */
export function detectTargetTriple(): string {
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  }
  return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
}

/**
 * The Rust target triple the sidecars are built for.
 *
 * Single source of truth for every build script: `RUST_TARGET` (set by the
 * release-*.sh / release-windows.ps1 scripts) wins, then
 * `TAURI_ENV_TARGET_TRIPLE` (injected by tauri-cli), then the host triple.
 *
 * Every script must use this instead of reading the environment on its own.
 * `predev.ts` used to read only `TAURI_ENV_TARGET_TRIPLE`, which the release
 * scripts never set, so it decided the cargo build target from one source and
 * the sidecar file name (via this module's default argument) from another:
 * cross-compiling named the sidecar after the target triple while cargo
 * compiled for the host, shipping a host binary inside a foreign installer.
 */
// eslint-disable-next-line no-undef
export const RUST_TARGET = (
  process.env.RUST_TARGET ??
  process.env.TAURI_ENV_TARGET_TRIPLE ??
  detectTargetTriple()
).trim()

export function getCurrentSidecar(target = RUST_TARGET) {
  const binaryConfig = SIDECAR_BINARIES.find((b) => b.rustTarget === target)
  if (!binaryConfig) throw new Error(`Sidecar configuration not available for Rust target '${target}'`)

  return binaryConfig
}

export async function copyBinaryToSidecarFolder(source: string, target = RUST_TARGET) {
  // 将相对路径 source 解析为绝对路径（基于调用者的 cwd）
  const absSource = path.isAbsolute(source) ? source : path.resolve(process.cwd(), source)
  await $`mkdir -p ${SIDEARS_DIR}`
  const dest = windowsify(path.join(SIDEARS_DIR, `duoduocode-cli-${target}`), target)
  await $`cp ${absSource} ${dest}`
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS === "true") {
    const signScript = path.resolve(DESKTOP_DIR, "../../script/sign-windows.ps1")
    await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ${signScript} ${dest}`
  }

  console.log(`Copied ${absSource} to ${dest}`)
}

export function windowsify(filepath: string, target?: string) {
  if (filepath.endsWith(".exe")) return filepath
  const isWindowsTarget = process.platform === "win32" || (target && target.includes("windows"))
  return `${filepath}${isWindowsTarget ? ".exe" : ""}`
}

/**
 * 将 cargo build 产出的 duo-smart-layer 二进制复制到 sidecars/ 目录。
 * Tauri 要求 sidecar 文件名格式为 `<name>-<target-triple>[.exe]`。
 *
 * @param cargoTargetDir - cargo 构建产物所在目录（如 `../../target/release` 或 `../../target/{triple}/release`）
 * @param target - Rust target triple（来自 TAURI_ENV_TARGET_TRIPLE）
 */
export async function copySmartLayerToSidecarFolder(cargoTargetDir: string, target = RUST_TARGET) {
  // 将相对路径解析为绝对路径（基于调用者的 cwd）
  const absCargoDir = path.isAbsolute(cargoTargetDir) ? cargoTargetDir : path.resolve(process.cwd(), cargoTargetDir)
  await $`mkdir -p ${SIDEARS_DIR}`
  const source = windowsify(path.join(absCargoDir, "duo-smart-layer"), target)
  const dest = windowsify(path.join(SIDEARS_DIR, `duo-smart-layer-${target}`), target)
  await $`cp ${source} ${dest}`
  if (process.platform === "win32" && process.env.GITHUB_ACTIONS === "true") {
    const signScript = path.resolve(DESKTOP_DIR, "../../script/sign-windows.ps1")
    await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ${signScript} ${dest}`
  }

  console.log(`Copied ${source} to ${dest}`)
}
