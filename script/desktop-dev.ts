#!/usr/bin/env bun
/**
 * 一键启动桌面端脚本
 *
 * 执行完整流程：
 *   1. 构建 duoduocode CLI sidecar
 *   2. 构建 duo-smart-layer sidecar
 *   3. 复制 sidecar 二进制文件到 src-tauri/sidecars/
 *   4. 启动 Tauri 桌面应用（含 Vite 开发服务器）
 *
 * 用法：
 *   bun run script/desktop-dev.ts
 *   # 或通过 package.json：
 *   bun run desktop
 *
 * 环境变量：
 *   DEBUG=1          — 使用 debug 模式编译 Rust（减少编译时间和 CPU 占用）
 *   RUST_TARGET / TAURI_ENV_TARGET_TRIPLE — 指定交叉编译目标三元组（都未设置时自动检测本机）
 */

import { spawn } from "child_process"
import * as path from "path"

import { RUST_TARGET } from "../packages/desktop/scripts/utils"

const ROOT_DIR = path.resolve(import.meta.dir, "..")
const DESKTOP_DIR = path.join(ROOT_DIR, "packages/desktop")

// 单一真源：RUST_TARGET ?? TAURI_ENV_TARGET_TRIPLE ?? 本机 triple。
// 与 predev.ts / sidecar 构建共用同一个解析结果，避免两边算出不同的目标平台。
const TARGET_TRIPLE = RUST_TARGET

// 构建子进程环境变量（继承当前进程 + 注入 TARGET_TRIPLE）
function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  env.TAURI_ENV_TARGET_TRIPLE = TARGET_TRIPLE
  return env
}

/**
 * 以子进程方式运行命令，实时输出 stdout/stderr，返回退出码。
 * Windows 上使用 shell: true 以正确解析 bun.bat 等脚本。
 */
function runCommand(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32"
    const child = spawn(command, args, {
      cwd,
      env: buildEnv(),
      stdio: "inherit",
      shell: isWin,
    })

    child.on("close", (code) => {
      resolve(code ?? 1)
    })

    child.on("error", (err) => {
      console.error(`进程启动失败: ${err.message}`)
      resolve(1)
    })
  })
}

/**
 * 关闭占用指定端口的进程。
 * 防止旧的 Vite dev server 成为孤儿残留、顶着端口，
 * 导致下次启动时 Tauri 连上旧代码（例如含 422 行 `.reason` 读取的旧版 session-turn.tsx），
 * 表现为前端稳定崩溃且源码改变无效。
 */
async function killPortProcesses(port: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const onDone = () => resolve()
    let proc: ReturnType<typeof spawn>
    if (process.platform === "win32") {
      proc = spawn(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `$pids=(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique; foreach($id in $pids){ if($id){ taskkill /F /PID $id | Out-Null } }`,
        ],
        { stdio: "ignore" },
      )
    } else {
      proc = spawn("sh", ["-c", `lsof -ti tcp:${port} | xargs -r kill -9`], {
        stdio: "ignore",
      })
    }
    proc.on("close", onDone)
    proc.on("error", onDone)
  })
}

console.log("🚀 DuoDuoCode 桌面端一键启动")
console.log("=".repeat(40))
console.log(`   平台: ${process.platform} (${TARGET_TRIPLE})`)

// ─── Step 1: 运行 predev（构建 sidecars） ───
console.log("\n📦 [1/2] 构建 sidecar 二进制文件...")
console.log("   这可能需要几分钟，特别是首次构建时。")

const predevExitCode = await runCommand("bun", ["run", "predev"], DESKTOP_DIR)

if (predevExitCode !== 0) {
  console.error("❌ sidecar 构建失败")
  console.error("   提示：确保已安装 Rust 工具链 (rustup.rs)")
  console.error("   提示：设置 DEBUG=1 可加速编译")
  console.error(`   提示：当前 target triple: ${TARGET_TRIPLE}`)
  process.exit(1)
}

console.log("✅ sidecar 构建完成")

// ─── Step 1.5: 启动前清理残留的孤儿进程 ───
// 关键：若上一次运行未完全退出，其 Vite dev server 仍顶着 1420 端口，
// 本次 tauri dev 会连上那份旧代码（源码改动无效、前端表现为旧版）。
// 必须在启动 tauri dev 之前清理，杜绝竞态。脚本末尾也会再清一次。
console.log("\n🧹 清理可能残留的 dev server / sidecar 孤儿进程...")
try {
  await killPortProcesses(1420)
} catch {}
if (process.platform === "win32") {
  try {
    spawn("taskkill", ["/F", "/IM", "duoduocode-cli.exe"], { stdio: "ignore", shell: true })
    spawn("taskkill", ["/F", "/IM", "duo-smart-layer.exe"], { stdio: "ignore", shell: true })
  } catch {}
}

// ─── Step 2: 启动 Tauri 桌面应用 ───
console.log("\n🖥️  [2/2] 启动 Tauri 桌面应用...")
console.log("   Vite 开发服务器将在 http://localhost:1420 启动")
console.log("   按 Ctrl+C 可退出应用\n")

const tauriExitCode = await runCommand("bun", ["run", "tauri", "dev"], DESKTOP_DIR)

// Kill any lingering sidecar processes that Tauri may not have cleaned up.
// On Windows, tauri dev sometimes exits before the shutdown handler completes,
// leaving duoduocode-cli and duo-smart-layer as orphan processes.
if (process.platform === "win32") {
  try {
    const kill = (name: string) => spawn("taskkill", ["/F", "/IM", `${name}.exe`], { stdio: "ignore", shell: true })
    kill("duoduocode-cli")
    kill("duo-smart-layer")
  } catch {}
}

// 关闭占用 Vite 开发端口(1420, 即 tauri.conf.json 的 devUrl)的孤儿 dev server，
// 避免残留旧进程顶着端口、导致下次启动连上旧代码而前端崩溃。
try {
  await killPortProcesses(1420)
} catch {
  // 端口无占用或清理失败均为可忽略，不影响主流程退出
}

// tauri dev 退出时可能返回非零退出码（用户 Ctrl+C 也是），这是正常行为
if (tauriExitCode !== 0) {
  console.log("\n👋 桌面应用已退出")
}
