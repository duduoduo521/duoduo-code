/**
 * 第四节-B（LSP&KG 协同文档）构建期脚本：下载并预置 LSP 二进制 + Node 运行时。
 *
 * 产物放置（与 bundle-resources.ts 的查找路径一一对应）：
 *   src-tauri/resources/node/node[.exe]              → 运行时搬到 Global.Path.bin/node[.exe]
 *   src-tauri/resources/packages/<pkg>               → 运行时搬到 cache/packages/<pkg>
 *   src-tauri/resources/binaries/<bin>-<triple>[.exe] → 运行时搬到 bin/<bin>[.exe]
 *
 * 运行要求：联网下载真实产物（Node 官网 + 各语言服务器 GitHub release + npm registry）。
 * 本脚本不在代码评审对话内执行下载，仅交付可运行的构建逻辑。
 *
 * 用法：
 *   RUST_TARGET=x86_64-apple-darwin bun run scripts/fetch-lsp-binaries.ts   # 单平台
 *   bun run scripts/fetch-lsp-binaries.ts --all                            # 全平台
 *
 * 单平台模式下目标三元组取 utils.RUST_TARGET（RUST_TARGET ?? TAURI_ENV_TARGET_TRIPLE ??
 * 本机 triple），与 predev.ts 构建 sidecar 用的是同一个值。
 */

import { $ } from "bun"
import * as zlib from "node:zlib"
import * as fs from "fs/promises"
import * as nodeFs from "node:fs"
import * as path from "path"
import * as os from "node:os"
import { createHash } from "node:crypto"
import { fileURLToPath } from "url"

import { RUST_TARGET } from "./utils"

// 同步判断文件/目录是否存在（用于 fs.cp 的 filter，避免对缺失条目抛 ENOENT）
function existsSyncSafe(p: string): boolean {
  try {
    nodeFs.accessSync(p, nodeFs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.resolve(__dirname, "..")
const TAURI_DIR = path.resolve(DESKTOP_DIR, "src-tauri")
const RESOURCES_DIR = path.join(TAURI_DIR, "resources")
// 下载/解压的中间产物目录（不在 resources 下，永不进安装包）
const WORK_DIR = path.join(TAURI_DIR, "lsp-fetch-work")
// 本地持久缓存（仓库外，避免污染 git/安装包）：命中则跳过网络下载与重试。
// 缓存键带 name+version+triple，版本升级或平台变化自动失效。
const LSP_CACHE = path.join(os.homedir(), ".cache", "duoduo-lsp")

// release-*.sh / release-windows.ps1 会 export GITHUB_MIRROR（国内镜像）。
// 在此真实生效：镜像值是完整前缀（如 https://mirror.ghproxy.com/https://github.com），
// 直接整体替换 URL 的 github.com 前缀，得到 <mirror>/https://github.com/<owner>/<repo>/...
function mirror(url: string): string {
  const mirrorBase = process.env.GITHUB_MIRROR?.replace(/\/+$/, "")
  if (mirrorBase && url.startsWith("https://github.com/")) {
    return url.replace(/^https:\/\/github\.com/, mirrorBase)
  }
  return url
}

async function download(url: string, dest: string) {
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const finalUrl = mirror(url)
  console.log(`[download] ${finalUrl} → ${dest}`)
  // GitHub releases 大文件常见瞬时 ECONNRESET/ConnectionRefused：3 次指数退避重试
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(finalUrl)
      if (!resp.ok) throw new Error(`download failed ${resp.status}: ${finalUrl}`)
      const buf = await resp.arrayBuffer()
      await fs.writeFile(dest, Buffer.from(buf))
      return
    } catch (err) {
      if (attempt === 3) throw err
      const delay = attempt * 3000
      console.warn(`[download] attempt ${attempt} failed (${String(err)}), retrying in ${delay}ms...`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
}

// 带本地缓存的下载：命中缓存（仓库外持久目录，键含 name+version+triple）直接复制，
// 跳过网络下载与重试；未命中则下载并回填缓存。版本/平台变化因键不同自动失效。
async function cachedDownload(url: string, cacheKey: string, dest: string) {
  const cached = path.join(LSP_CACHE, cacheKey)
  if (existsSyncSafe(cached)) {
    console.log(`[cache] hit ${cacheKey} → ${dest}`)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.copyFile(cached, dest)
    return
  }
  await download(url, dest)
  await fs.mkdir(LSP_CACHE, { recursive: true })
  await fs.copyFile(dest, cached)
}

// 跨平台解压（Windows 无 unzip/gunzip 命令）：
//   .zip     → Windows 10+ 自带 bsdtar（tar -xf 支持 zip）；unix 用 unzip
//   .tar.gz  → 三平台 tar -xzf
//   .gz(裸)  → node:zlib 纯 JS gunzip，无外部命令依赖
async function extract(archive: string, outDir: string) {
  await fs.mkdir(outDir, { recursive: true })
  if (archive.endsWith(".zip")) {
    if (process.platform === "win32") {
      await $`tar -xf ${archive} -C ${outDir}`.quiet()
    } else {
      await $`unzip -o ${archive} -d ${outDir}`.quiet()
    }
  } else if (archive.endsWith(".tar.gz") || archive.endsWith(".tgz")) {
    await $`tar -xzf ${archive} -C ${outDir}`.quiet()
  } else if (archive.endsWith(".gz")) {
    // 裸 gzip 单文件（rust-analyzer）
    const base = archive.replace(/\.gz$/, "")
    const compressed = await fs.readFile(archive)
    await fs.writeFile(base, zlib.gunzipSync(compressed))
    await fs.chmod(base, 0o755)
  }
}

// 在解压目录中递归查找（限深度）一个可执行文件：先精确名，再 StartsWith 名。
async function findBinary(root: string, exact: string, prefix: string, maxDepth = 3): Promise<string | undefined> {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let fallback: string | undefined
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!
    let entries: import("fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (!ent.isFile()) {
        if (ent.isDirectory() && depth < maxDepth) queue.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (ent.name === exact) return full
      if (fallback === undefined && ent.name.startsWith(prefix)) fallback = full
    }
  }
  return fallback
}

// ── 版本（按需升级；与 server.ts 各 LSP server 兼容） ──────────────────────
const VERSIONS = {
  node: "v20.18.0",
  deno: "v1.46.3",
  clangd: "18.1.3",
  rustAnalyzer: "2024-09-30",
}

// A 类 npm 包（包名集合与 bundle-resources.ts NPM_PACKAGES 保持一致）。
// 版本必须冻结：裸名安装会跟随 latest 漂移——typescript@7 已移除
// lib/tsserver.js，而 server.ts Typescript.spawn 以该文件为锚点，
// 装到 7.x 会导致 TS 语言支持整体失效。typescript 定 5.9.3（5.x 最后
// 稳定线，含 tsserver.js），其余冻结在 2026-08 验证过的版本。
const NPM_PACKAGES: Array<{ name: string; spec: string }> = [
  { name: "typescript", spec: "typescript@5.9.3" },
  { name: "typescript-language-server", spec: "typescript-language-server@5.3.0" },
  { name: "@vue/language-server", spec: "@vue/language-server@3.3.10" },
  { name: "@vtsls/language-server", spec: "@vtsls/language-server@0.3.0" },
  { name: "tailwindcss-language-server", spec: "tailwindcss-language-server@0.0.1" },
  { name: "@biomejs/biome", spec: "@biomejs/biome@2.5.8" },
  { name: "pyright", spec: "pyright@1.1.413" },
  { name: "svelte-language-server", spec: "svelte-language-server@0.18.4" },
  { name: "@astrojs/language-server", spec: "@astrojs/language-server@2.16.14" },
  { name: "yaml-language-server", spec: "yaml-language-server@1.24.0" },
  // intephense 刻意不在列：专有许可（第 5(c) 条禁止再分发），不可随包分发。
  { name: "bash-language-server", spec: "bash-language-server@5.6.0" },
  { name: "dockerfile-language-server-nodejs", spec: "dockerfile-language-server-nodejs@0.15.0" },
  { name: "vscode-langservers-extracted", spec: "vscode-langservers-extracted@4.10.0" },
]

// 平台三元组 → 目录/文件名片段。
//   arch        = node/gopls 的命名风格（arm64/x64）
//   rustArch    = rust triple 的命名风格（aarch64/x86_64），deno/rust-analyzer 用
const TARGETS = [
  { triple: "aarch64-apple-darwin", platform: "darwin", arch: "arm64", rustArch: "aarch64", ext: "", nodeExt: "tar.gz" },
  { triple: "x86_64-apple-darwin", platform: "darwin", arch: "x64", rustArch: "x86_64", ext: "", nodeExt: "tar.gz" },
  { triple: "x86_64-pc-windows-msvc", platform: "win32", arch: "x64", rustArch: "x86_64", ext: ".exe", nodeExt: "zip" },
  { triple: "x86_64-unknown-linux-gnu", platform: "linux", arch: "x64", rustArch: "x86_64", ext: "", nodeExt: "tar.gz" },
  { triple: "aarch64-unknown-linux-gnu", platform: "linux", arch: "arm64", rustArch: "aarch64", ext: "", nodeExt: "tar.gz" },
]

async function fetchNode(target: (typeof TARGETS)[number]) {
  const ver = VERSIONS.node
  const archiveName =
    target.platform === "win32"
      ? `node-${ver}-win-${target.arch}.zip`
      : `node-${ver}-${target.platform === "darwin" ? "darwin" : "linux"}-${target.arch}.tar.gz`
  const url = `https://nodejs.org/dist/${ver}/${archiveName}`
  // 中间产物（压缩包 + 解压目录）全部放 WORK_DIR，永不进入 resources/ → 不会被打进安装包
  const archive = path.join(WORK_DIR, "node", target.triple, archiveName)
  const outDir = path.join(WORK_DIR, "node", target.triple, "extracted")
  await cachedDownload(url, `node-${ver}-${target.triple}-${archiveName}`, archive)
  await extract(archive, outDir)
  // node 发行包解压后有顶层目录（node-v20.18.0-darwin-arm64/），二进制在 bin/ 下
  // （Windows zip 同样有顶层目录，node.exe 在其中）。递归查找以兼容两种布局。
  const binName = target.platform === "win32" ? "node.exe" : "node"
  const extractedBin = await findBinary(outDir, binName, "node")
  if (!extractedBin) throw new Error(`node binary not found after extracting ${archiveName}`)
  // 放置到 resources/node/node[.exe]（与 bundle-resources.ts 查找路径一致）
  const finalBin = path.join(RESOURCES_DIR, "node", binName)
  await fs.mkdir(path.dirname(finalBin), { recursive: true })
  await fs.copyFile(extractedBin, finalBin)
  if (target.platform !== "win32") await fs.chmod(finalBin, 0o755).catch(() => {})
  console.log(`[node] placed ${finalBin}`)
}

async function fetchExternal(target: (typeof TARGETS)[number]) {
  // clangd 官方（clangd/clangd 仓库）分发：mac 为 universal 双架构 zip
  // （x86_64+arm64，实测 file 验证），linux/windows 为 x64；linux arm64 无官方包
  // （运行时 spawn 会先取 PATH 上的 clangd，见 server.ts Clangd.spawn）
  const clangdToken = target.platform === "darwin" ? "mac" : target.platform === "win32" ? "windows" : "linux"
  const clangdSupported = target.triple !== "aarch64-unknown-linux-gnu"
  const bins = [
    {
      name: "deno",
      // deno 资产用 rust triple 命名（deno-aarch64-apple-darwin.zip），darwin arm64
      // 必须是 aarch64 而非 arm64；linux 用 triple 覆盖 x64 与 arm64
      url:
        target.platform === "win32"
          ? `https://github.com/denoland/deno/releases/download/${VERSIONS.deno}/deno-x86_64-pc-windows-msvc.zip`
          : target.platform === "darwin"
            ? `https://github.com/denoland/deno/releases/download/${VERSIONS.deno}/deno-${target.rustArch}-apple-darwin.zip`
            : `https://github.com/denoland/deno/releases/download/${VERSIONS.deno}/deno-${target.triple}.zip`,
    },
    {
      name: "clangd",
      // clangd/clangd 仓库资产：clangd-mac-<ver>.zip（universal：x86_64+arm64）/
      // clangd-linux-<ver>.zip / clangd-windows-<ver>.zip（与 server.ts 运行时
      // 下载逻辑的 token 映射完全一致）
      url: `https://github.com/clangd/clangd/releases/download/${VERSIONS.clangd}/clangd-${clangdToken}-${VERSIONS.clangd}.zip`,
    },
    {
      name: "rust-analyzer",
      // rust-analyzer 用 rust triple 命名的裸 gzip 单文件（aarch64/x86_64）
      url: `https://github.com/rust-lang/rust-analyzer/releases/download/${VERSIONS.rustAnalyzer}/rust-analyzer-${target.triple}.gz`,
    },
  ]
  if (!clangdSupported) {
    console.warn(`[external] clangd: no official linux arm64 build, skipping (user PATH clangd will be used at runtime)`)
  }

  for (const { name, url } of bins) {
    if (name === "clangd" && !clangdSupported) continue
    // 从 url 完整提取后缀（顺序关键：.tar.gz 必须先于 .gz 判断，
    // 否则 gopls 的 tar.gz 会被当裸 gzip 只解出一层 tar）
    const suffix = url.endsWith(".tar.gz") ? ".tar.gz" : url.endsWith(".zip") ? ".zip" : ".gz"
    const archive = path.join(WORK_DIR, "binaries", `${name}-${target.triple}${suffix}`)
    // 缓存键基于原始 url（含版本+triple）哈希，避免键名映射不一致导致失效
    const cacheKey = `external-${name}-${target.triple}-${createHash("sha1").update(url).digest("hex").slice(0, 12)}`
    await cachedDownload(url, cacheKey, archive)
    const outDir = path.join(WORK_DIR, "binaries", `${name}-${target.triple}-extracted`)
    await extract(archive, outDir)
    // 解压后文件名可能带平台后缀，统一重命名为 <name>-<triple>[.exe]
    // 放置到 resources/binaries/（与 bundle-resources.ts 查找路径一致）
    const finalName = `${name}-${target.triple}${target.ext}`
    const finalPath = path.join(RESOURCES_DIR, "binaries", finalName)
    const candidate =
      suffix === ".gz"
        ? archive.replace(/\.gz$/, "") // 裸 gzip：解压产物就在 work 目录，文件名即 <name>-<triple>
        : await findBinary(outDir, finalName, name)
    if (candidate && (await fs.stat(candidate).catch(() => null))) {
      await fs.mkdir(path.dirname(finalPath), { recursive: true })
      await fs.copyFile(candidate, finalPath)
      if (process.platform !== "win32") await fs.chmod(finalPath, 0o755).catch(() => {})
      console.log(`[external] placed ${finalPath}`)
    } else {
      console.warn(`[external] ${name} binary not found in ${outDir}`)
    }
  }
}

async function fetchNpmPackages() {
  const tmp = path.join(WORK_DIR, "packages-tmp")
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.mkdir(tmp, { recursive: true })
  // 孤立 package.json：阻止 bun 向上解析到 monorepo workspace 根
  // （否则包会装进 workspace 的 node_modules 而非 tmp）
  await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "lsp-bundle", private: true }))
  // Bun Shell 模板插值：数组会逐元素展开为独立参数
  await $`cd ${tmp} && bun add ${NPM_PACKAGES.map((p) => p.spec)}`.quiet()
  for (const { name } of NPM_PACKAGES) {
    const src = path.join(tmp, "node_modules", name)
    const dst = path.join(RESOURCES_DIR, "packages", name)
    await fs.rm(dst, { recursive: true, force: true })
    // bun/npm 安装的 node_modules 含嵌套依赖的符号链接与裁剪条目，
    // 部分子项（如 vscode-languageserver-types/thirdpartynotices.txt）
    // 在磁盘上未被物化，fs.cp 默认会遍历每个目录条目并尝试复制，
    // 遇到缺失文件即抛 ENOENT。这里用 filter 对每个条目先做 access
    // 校验，磁盘上不存在的条目直接跳过，避免复制中断。
    await fs.cp(src, dst, {
      recursive: true,
      filter: (srcPath) => {
        // 返回 false 的条目会被跳过；不存在的条目跳过而非报错
        return existsSyncSafe(srcPath)
      },
    })
    // bun 安装不生成 node_modules/.bin 软链目录，但部分被依赖（如
    // vscode-languageserver）的 bin 入口历史上曾被打进安装包资源树，
    // 导致 Tauri build script 在后续重构建时因清单中该文件缺失而校验失败。
    // 这些 .bin 软链对运行时 LSP 调用毫无作用（server.ts 直接 spawn
    // bin/ 下的真实可执行文件），统一删除，保证 resources/packages 产物自洽。
    const binDir = path.join(dst, "node_modules", ".bin")
    await fs.rm(binDir, { recursive: true, force: true })
    console.log(`[npm] placed ${dst}`)
  }
  await fs.rm(tmp, { recursive: true, force: true })
}

async function main(all = false) {
  // Same single source of truth as predev.ts and the sidecar naming:
  // RUST_TARGET ?? TAURI_ENV_TARGET_TRIPLE ?? host triple. Reading the
  // environment here as well would let the LSP binaries be fetched for one
  // platform while the sidecars are built for another.
  const targets = all ? TARGETS : TARGETS.filter((t) => t.triple === RUST_TARGET)

  if (targets.length === 0) {
    throw new Error(
      `No LSP target for Rust target '${RUST_TARGET}'. Supported: ${TARGETS.map((t) => t.triple).join(", ")}. ` +
        `Set RUST_TARGET/TAURI_ENV_TARGET_TRIPLE to one of those, or pass --all to fetch every platform.`,
    )
  }

  // 幂等重入：先清掉上一次运行的最终产物与中间产物，
  // 防止半途崩溃的残留（如未清理的 triple 目录）混进本次打包资源。
  for (const sub of ["node", "packages", "binaries"]) {
    await fs.rm(path.join(RESOURCES_DIR, sub), { recursive: true, force: true })
  }
  await fs.rm(WORK_DIR, { recursive: true, force: true })

  for (const target of targets) {
    console.log(`\n=== target ${target.triple} ===`)
    await fetchNode(target)
    await fetchExternal(target)
  }
  // npm 包与平台无关（同一份 node_modules 全平台复用）
  await fetchNpmPackages()
  // 收尾清理中间产物（下载的压缩包 / 解压目录），resources/ 只留最终产物
  await fs.rm(WORK_DIR, { recursive: true, force: true })
  console.log("\n[done] LSP binaries + Node preloaded into src-tauri/")
}

// 供 release-*.sh / release-windows.ps1 复用：只预置当前 RUST_TARGET 平台的二进制。
// 每个发布脚本只在本机跑一个平台，故单平台即可；npm 包（纯 JS）跨平台复用，各平台 fetch 一份。
export async function runFetchCurrentPlatform(): Promise<void> {
  await main(false)
}

// 供手动多平台预置使用（CI / 本地全量打包）
export async function runFetch(): Promise<void> {
  await main(true)
}

// 仅当作为入口脚本直接运行时执行（被 release 脚本 import 时不自动跑）
const isMain = process.argv[1]?.endsWith("fetch-lsp-binaries.ts")
if (isMain) {
  // 入口默认只跑当前平台；带 --all 才全平台
  const all = process.argv.includes("--all")
  main(all).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
