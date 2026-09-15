/**
 * ensure-license-resources.ts — 确保 Tauri 打包资源（LICENSE / ThirdPartyLicenses.txt）
 * 存在于 packages/desktop/src-tauri/（tauri.conf.json bundle.resources 所声明）。
 *
 * - LICENSE 是仓库根的 git 跟踪文件，直接复制。
 * - ThirdPartyLicenses.txt 是 .gitignore 排除的构建期产物（由
 *   scripts/generate-third-party-licenses.ts 生成），缺失时在此生成。
 *
 * 调用方：
 *   - scripts/predev.ts     （dev：缺失仅告警，不阻断）
 *   - package.json "build"  （tauri build 的 beforeBuildCommand：--strict，缺失即失败）
 */
import { $ } from "bun"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP_DIR = path.resolve(__dirname, "..")
const MONOREPO_ROOT = path.resolve(DESKTOP_DIR, "../..")
const TAURI_DIR = path.join(DESKTOP_DIR, "src-tauri")

const STRICT = process.argv.includes("--strict")

const LICENSE_ROOT = path.join(MONOREPO_ROOT, "LICENSE")
const THIRD_PARTY_ROOT = path.join(MONOREPO_ROOT, "ThirdPartyLicenses.txt")

function copy(src: string, dst: string): boolean {
  try {
    fs.copyFileSync(src, dst)
    console.log(`Copied ${path.basename(src)} -> src-tauri/`)
    return true
  } catch {
    console.warn(`${path.basename(src)} not found at ${src}`)
    return false
  }
}

async function main() {
  if (!fs.existsSync(THIRD_PARTY_ROOT)) {
    console.log("ThirdPartyLicenses.txt missing, generating...")
    try {
      await $`bun run scripts/generate-third-party-licenses.ts`.cwd(MONOREPO_ROOT)
    } catch (e) {
      console.warn("generate-third-party-licenses.ts failed:", e)
    }
  }

  const licenseOk = copy(LICENSE_ROOT, path.join(TAURI_DIR, "LICENSE"))
  const thirdPartyOk = copy(THIRD_PARTY_ROOT, path.join(TAURI_DIR, "ThirdPartyLicenses.txt"))

  if (STRICT && (!licenseOk || !thirdPartyOk)) {
    console.error("FATAL: Tauri bundle resources (LICENSE / ThirdPartyLicenses.txt) are missing.")
    process.exit(1)
  }
}

main()
