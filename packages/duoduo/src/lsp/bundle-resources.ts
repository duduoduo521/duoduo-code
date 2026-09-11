import fs from "fs/promises"
import path from "path"

import { Global } from "../global"
import { Log } from "../util"
import { Flag } from "../flag/flag"

/**
 * 第四节-B（LSP&KG 协同文档）：包内预置 LSP 二进制 + Node 运行时的首启搬运模块。
 *
 * 实装事实修正：后端 CLI 是独立 Bun 进程，没有 Tauri 前端运行时，
 * 无法调用 Tauri `path.resourceDir()`。因此资源目录按以下优先级推导：
 *   1. env `DUODUO_BUNDLE_DIR`（前端启动 CLI 时传入，最可靠）
 *   2. 从 `process.execPath` 推导安装根下的 `resources/`
 *      （Tauri 打包后 `bundle.resources` 落到安装目录的 `resources/`，
 *       与 sidecar 可执行文件同根）
 *
 * 搬运目标严格复用既有查找路径（零侵入，不改 which.ts / npm/index.ts）：
 *   - Node / B 类外部二进制 → `Global.Path.bin`（which.ts 已把该目录加入 PATH）
 *   - A 类 npm 包 → `global.cache/packages/<pkg>`（Npm.which 查找
 *     `packages/<pkg>/node_modules/.bin` 的父级）
 *
 * 幂等：全局 `ensured` 保证只搬运一次；目标已存在则跳过。
 * 仅当 `DUODUO_DISABLE_LSP_DOWNLOAD` 为真（默认）时搬运；
 * 允许回退下载（显式 false）的场景跳过，留给 dev/未打包环境。
 */

const log = Log.create({ service: "lsp.bundle-resources" })

function resolveBundleDir(): string | undefined {
  const fromEnv = process.env["DUODUO_BUNDLE_DIR"]
  if (fromEnv) return fromEnv
  try {
    return path.join(path.dirname(process.execPath), "resources")
  } catch {
    return undefined
  }
}

function platformExt(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name
}

// 运行时三元组（与 Tauri externalBin / fetch-lsp-binaries.ts 命名一致）
function targetTriple(): string {
  const p = process.platform
  const a = process.arch
  if (p === "darwin") return a === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  if (p === "win32") return "x86_64-pc-windows-msvc"
  return a === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
}

// B 类外部二进制（spawn 来源见 server.ts）：deno / gopls / clangd / rust-analyzer
// 注：gopls 官方不发布预编译二进制（仅 go install 编译），fetch 脚本不会预置它，
// 此处保留条目使 stat 跳过；运行时走 which("gopls") → go install（受 D7 开关控制）
const EXTERNAL_BINARIES = ["deno", "gopls", "clangd", "rust-analyzer"]

// A 类 npm 包（spawn 来源见 server.ts Npm.which）：
// 包名与目标子目录同名（bundleDir/packages/<pkg> → cache/packages/<pkg>）。
// 已与 server.ts 全部 Npm.which 调用核对一致。
// 注：vscode-eslint / eslint 走特殊 zip 解压路径（Global.Path.bin/vscode-eslint），
// 不在 Npm.which 标准路径内，故不列入此处（D7 禁下载时按文档表格亦不包含）。
// 注：intelephense 刻意不在列 —— 其为专有许可（第 5(c) 条禁止再分发），
// 随包分发不可，故不预置、不搬运；PHP 侧仅使用用户自行安装的版本（见
// server.ts PHPIntelephense）以及自研 AST/KG 引擎。
const NPM_PACKAGES = [
  "typescript",
  "typescript-language-server",
  "@vue/language-server",
  "@vtsls/language-server",
  "tailwindcss-language-server",
  "@biomejs/biome",
  "pyright",
  "svelte-language-server",
  "@astrojs/language-server",
  "yaml-language-server",
  "bash-language-server",
  "dockerfile-language-server-nodejs",
  "vscode-langservers-extracted",
]

async function copyTreeIfMissing(src: string, dst: string, executable = false): Promise<boolean> {
  try {
    if (await fs.stat(dst).catch(() => null)) {
      // 目标已存在，但确保可执行权限（mac/linux 搬运会丢失 +x）
      if (executable && process.platform !== "win32") {
        await fs.chmod(dst, 0o755).catch(() => null)
      }
      return false
    }
    await fs.mkdir(path.dirname(dst), { recursive: true })
    await fs.cp(src, dst, { recursive: true })
    if (executable && process.platform !== "win32") {
      await fs.chmod(dst, 0o755).catch(() => null)
    }
    return true
  } catch (err) {
    log.warn("bundle copy failed", { src, dst, error: String(err) })
    return false
  }
}

let ensured = false

export async function ensureBundleResources(): Promise<void> {
  if (ensured) return
  ensured = true

  // 允许回退下载（显式 DUODUO_DISABLE_LSP_DOWNLOAD=false）时跳过搬运，
  // 留给 dev / 未打包场景走既有下载逻辑。
  if (!Flag.DUODUO_DISABLE_LSP_DOWNLOAD) return

  const bundleDir = resolveBundleDir()
  if (!bundleDir) {
    log.warn("bundle dir unresolved; skip preload")
    return
  }

  const binDir = Global.Path.bin
  const pkgBase = path.join(path.dirname(binDir), "packages")

  // Node 运行时 → bin/node[.exe]（需可执行权限）
  const nodeSrc = path.join(bundleDir, "node", platformExt("node"))
  if (await fs.stat(nodeSrc).catch(() => null)) {
    await copyTreeIfMissing(nodeSrc, path.join(binDir, platformExt("node")), true)
  }

  // B 类外部二进制 → bin/<name>[.exe]（需可执行权限）
  // 源路径：resources/binaries/<name>-<triple>[.exe]（与 fetch-lsp-binaries.ts 命名一致）
  const triple = targetTriple()
  for (const bin of EXTERNAL_BINARIES) {
    const src = path.join(bundleDir, "binaries", `${bin}-${triple}${process.platform === "win32" ? ".exe" : ""}`)
    if (await fs.stat(src).catch(() => null)) {
      await copyTreeIfMissing(src, path.join(binDir, platformExt(bin)), true)
    }
  }

  // A 类 npm 包 → packages/<pkg>
  for (const pkg of NPM_PACKAGES) {
    const src = path.join(bundleDir, "packages", pkg)
    if (await fs.stat(src).catch(() => null)) {
      await copyTreeIfMissing(src, path.join(pkgBase, pkg))
    }
  }

  log.info("bundle resources ensured", { bundleDir })
}
