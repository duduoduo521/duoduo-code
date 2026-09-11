import { $ } from "bun"
import { existsSync, mkdirSync, readdirSync } from "fs"
import { join, relative } from "path"

// 本脚本在 packages/desktop 目录下运行（release-windows.ps1 已 Set-Location 至此），
// 故相对路径以 packages/desktop 为基准：
// - workspace 模式下 Cargo 把 target 输出到 duoduo-ai-ide/target（两层 ../ 到 workspace 根）
// - tauri 默认（非 workspace）输出到 src-tauri/target
// DST 同样落到 workspace 根的 dist-artifacts，与 release-windows.ps1 的 $DistArtifacts 对齐。
const SRC_CANDIDATES = [
  "../../target/release/bundle",
  "src-tauri/target/release/bundle",
]
const SRC = SRC_CANDIDATES.find((p) => existsSync(p))
const DST = "../../dist-artifacts"

if (!SRC) {
  console.log(
    `No bundle artifacts found in any of: ${SRC_CANDIDATES.join(", ")}, skipping copy`,
  )
  process.exit(0)
}
console.log(`Using bundle dir: ${SRC}`)

if (!existsSync(DST)) mkdirSync(DST, { recursive: true })

const platforms = readdirSync(SRC, { withFileTypes: true }).filter((d) => d.isDirectory())

for (const platform of platforms) {
  const srcDir = join(SRC, platform.name)
  const files = readdirSync(srcDir, { withFileTypes: true, recursive: true }).filter((f) => f.isFile())

  for (const file of files) {
    const src = join(file.parentPath || srcDir, file.name)
    const dst = join(DST, file.name)
    await $`cp ${src} ${dst}`.quiet()
    console.log(`  ${src} → ${file.name}`)
  }
}

console.log(`\nArtifacts copied to ${DST}/`)
