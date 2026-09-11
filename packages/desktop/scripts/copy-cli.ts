#!/usr/bin/env bun
import { $ } from "bun"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))


// 脚本位于 packages/desktop/scripts/，用 __dirname 解析绝对路径，不依赖调用方 cwd：
// - sidecar 产物: src-tauri/sidecars/duoduocode-cli-<target>[.exe]
//   交叉编译后会同时存在多个平台的 sidecar（如 aarch64-apple-darwin / x86_64-apple-darwin），
//   与桌面端 copy-artifacts.ts 遍历 bundle 下所有平台目录的范式一致，本脚本同样
//   遍历所有已构建的 sidecar，不依赖当前运行机器的 arch。
// - 上传目录:     <workspace根>/update-upload/cli/v<VERSION>/<target>/duoduocode-cli-<target>[.exe]
//   <target> 为平台 triple 目录，镜像 update-upload 顶层的 v<>/ + <target>/ 双结构。

const SIDEARS_DIR = join(__dirname, "..", "src-tauri", "sidecars")
// UPDATE_UPLOAD 优先取环境变量（由 release 脚本传入已验证的绝对路径），
// 否则回退到基于本脚本位置的推算（scripts → desktop → duoduo-ai-ide → workspace根）。
const UPDATE_UPLOAD = process.env.UPDATE_UPLOAD ?? join(__dirname, "..", "..", "..", "update-upload")

// 匹配所有 duoduocode-cli-<target>[.exe]，从文件名解析平台 triple
function parseTarget(fileName: string): string | null {
  const m = fileName.match(/^duoduocode-cli-(.+?)(\.exe)?$/)
  return m ? m[1]! : null
}

const VERSION = process.env.VERSION
if (!VERSION) {
  console.error("VERSION env not set, skipping CLI copy")
  process.exit(0)
}

if (!existsSync(SIDEARS_DIR)) {
  console.error(`sidecars dir not found: ${SIDEARS_DIR}, skipping CLI copy`)
  process.exit(0)
}

const files = readdirSync(SIDEARS_DIR).filter((f) => /^duoduocode-cli-.+/.test(f))
if (files.length === 0) {
  console.error(`no duoduocode-cli-* sidecar found in ${SIDEARS_DIR}, skipping CLI copy`)
  process.exit(0)
}

let copied = 0
for (const fileName of files) {
  const target = parseTarget(fileName)
  if (!target) continue

  const src = join(SIDEARS_DIR, fileName)
  const dstDir = join(UPDATE_UPLOAD, "cli", `v${VERSION}`, target)
  mkdirSync(dstDir, { recursive: true })
  const dst = join(dstDir, fileName)

  await $`cp ${src} ${dst}`.quiet()
  console.log(`CLI binary copied: ${src} → ${dst}`)
  copied++
}

console.log(`\nCopied ${copied} CLI binary(ies) to ${UPDATE_UPLOAD}/cli/v${VERSION}/`)

// ── 复制 CLI 安装脚本到 update-upload/cli/（供 curl 安装通道 code/cli/cli 与 code/cli/cli.ps1 使用）──
// 安装脚本源文件与 copy-cli.ts 同目录（packages/desktop/scripts/），由 git 跟踪，
// 避免直接维护 gitignored 的 update-upload 暂存副本。
const SCRIPT_DIR = __dirname
const cliDir = join(UPDATE_UPLOAD, "cli")
mkdirSync(cliDir, { recursive: true })

const installerSh = join(SCRIPT_DIR, "cli-install.sh")
if (existsSync(installerSh)) {
  await $`cp ${installerSh} ${join(cliDir, "cli")}`.quiet()
  console.log(`CLI installer copied: ${installerSh} → ${join(cliDir, "cli")}`)
} else {
  console.error(`CLI installer script not found: ${installerSh}, skipping`)
}

const installerPs1 = join(SCRIPT_DIR, "cli-install.ps1")
if (existsSync(installerPs1)) {
  await $`cp ${installerPs1} ${join(cliDir, "cli.ps1")}`.quiet()
  console.log(`CLI installer copied: ${installerPs1} → ${join(cliDir, "cli.ps1")}`)
} else {
  console.error(`CLI installer script not found: ${installerPs1}, skipping`)
}

// 写入 latest 文本文件，供安装脚本在无 VERSION（全新安装）时解析最新版本
writeFileSync(join(cliDir, "latest"), VERSION, "utf8")
console.log(`CLI latest version file written: ${join(cliDir, "latest")} = ${VERSION}`)
