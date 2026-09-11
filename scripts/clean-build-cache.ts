#!/usr/bin/env -S bun run
/**
 * clean-build-cache.ts — 跨平台清理 duoduo-ai-ide 构建缓存
 *
 * 仅清理 .gitignore 覆盖的派生产物，绝不触碰源码与 git 历史。
 * 兼容 Windows / macOS / Linux（依赖 Node/Bun 内置 API，无第三方依赖）。
 *
 * 用法:
 *   bun run scripts/clean-build-cache.ts            # 安全清理（保留 release 安装包）
 *   bun run scripts/clean-build-cache.ts --deep      # 连 target/release 一起清
 *   bun run scripts/clean-build-cache.ts --dry       # 只统计将释放的空间，不删除
 *   bun run scripts/clean-build-cache.ts --deep --dry
 *   bun run scripts/clean-build-cache.ts --yes       # 跳过确认直接执行
 *
 * 也可通过根目录: bun run clean / bun run clean -- --deep
 */
import { existsSync, statSync, rmSync, readdirSync } from "node:fs"
import { join, resolve, relative } from "node:path"
import { platform } from "node:os"

const ROOT = resolve(import.meta.dir, "..")

type Options = {
  deep: boolean
  dry: boolean
  yes: boolean
}

function parseArgs(argv: string[]): Options {
  const has = (f: string) => argv.includes(f)
  return {
    deep: has("--deep"),
    dry: has("--dry"),
    yes: has("--yes"),
  }
}

/** 递归计算目录/文件字节数（用于报告，不会删除时再算） */
function sizeOf(p: string): number {
  let total = 0
  try {
    const st = statSync(p)
    if (st.isFile()) return st.size
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) {
        total += sizeOf(join(p, entry))
      }
    }
  } catch {
    // 权限/竞态错误忽略
  }
  return total
}

/** 是否位于 .git 目录内（避免误清 git 内部对象） */
function isGitInternals(p: string): boolean {
  return p.split(/[\\/]/).includes(".git")
}

/**
 * 收集要清理的目标。返回绝对路径数组。
 * 设计原则：只删"纯派生产物"，每个条目都在 .gitignore 中。
 */
function collectTargets(opt: Options): string[] {
  const targets: string[] = []

  const pushIfExists = (p: string) => {
    const abs = resolve(ROOT, p)
    if (existsSync(abs) && !isGitInternals(abs)) targets.push(abs)
  }

  // 1. 各 workspace 的 node_modules
  pushIfExists("node_modules")
  pushIfExists("packages/app/node_modules")
  pushIfExists("packages/desktop/node_modules")
  pushIfExists("packages/duoduo/node_modules")
  pushIfExists("packages/sdk/js/node_modules")
  pushIfExists("packages/ui/node_modules")

  // 2. TypeScript 增量产物
  pushIfExists("packages/app/node_modules/.ts-dist")
  pushIfExists("packages/desktop/node_modules/.ts-dist")
  // 顶层及 package 下的 *.tsbuildinfo
  const findTsBuildInfo = (dir: string, depth: number) => {
    if (depth > 4 || !existsSync(dir)) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e)
      if (isGitInternals(full)) continue
      if (e === "node_modules") continue
      if (e.endsWith(".tsbuildinfo")) targets.push(full)
      else {
        try {
          if (statSync(full).isDirectory()) findTsBuildInfo(full, depth + 1)
        } catch {
          /* ignore */
        }
      }
    }
  }
  findTsBuildInfo(ROOT, 0)

  // 3. Rust 编译产物 target/
  //    - 默认: 只清 target/debug（最大头，且 debug 不影响已生成安装包）
  //    - deep: 清整个 target/
  const pushTarget = (sub: string) => pushIfExists(sub)
  if (opt.deep) {
    pushTarget("target")
    pushTarget("packages/desktop/src-tauri/target")
    pushTarget("crates/target")
  } else {
    pushTarget("target/debug")
    pushTarget("packages/desktop/src-tauri/target/debug")
    pushTarget("crates/target/debug")
  }

  return targets
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ["KiB", "MiB", "GiB", "TiB"]
  let i = -1
  let v = n
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  return `${v.toFixed(2)} ${units[i]}`
}

function confirm(question: string): Promise<boolean> {
  // Bun 提供 prompt；Node 用 readline。这里用最兼容的 readline。
  const { createInterface } = require("node:readline")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(`${question} (y/N) `, (ans) => {
      rl.close()
      resolve(/^y(es)?$/i.test(ans.trim()))
    })
  })
}

async function main() {
  const opt = parseArgs(process.argv.slice(2))
  const platformName = platform()

  console.log("==================================================")
  console.log(" duoduo-ai-ide 构建缓存清理")
  console.log(` 平台: ${platformName}`)
  console.log(` 模式: ${opt.deep ? "deep（含 target/release）" : "安全（保留 release 安装包）"}`)
  console.log(` 执行: ${opt.dry ? "dry-run（仅统计，不删除）" : "实际删除"}`)
  console.log(` 根目录: ${ROOT}`)
  console.log("==================================================")

  const targets = collectTargets(opt)
  if (targets.length === 0) {
    console.log("\n没有发现可清理的缓存，目录已很干净。")
    return
  }

  let total = 0
  console.log("\n将清理以下目标:")
  for (const t of targets) {
    const size = sizeOf(t)
    total += size
    console.log(`  [${fmtBytes(size).padStart(10)}]  ${relative(ROOT, t) || "."}`)
  }
  console.log(`\n预计释放: ${fmtBytes(total)}`)

  if (opt.dry) {
    console.log("\n(dry-run) 未做任何删除。")
    return
  }

  const ok = opt.yes ? true : await confirm("\n确认删除以上目录?")
  if (!ok) {
    console.log("已取消。")
    return
  }

  let freed = 0
  let failed = 0
  for (const t of targets) {
    try {
      const size = sizeOf(t)
      rmSync(t, { recursive: true, force: true, maxRetries: 3 })
      freed += size
      console.log(`  ✓ 已删除 ${relative(ROOT, t) || "."}`)
    } catch (err) {
      failed++
      console.error(`  ✗ 删除失败 ${relative(ROOT, t)}: ${(err as Error).message}`)
    }
  }

  console.log(`\n完成。实际释放: ${fmtBytes(freed)}` + (failed ? `，失败 ${failed} 项` : ""))
  console.log("提示: 下次构建会重新生成这些缓存，首次编译会稍慢。")
}

main()
