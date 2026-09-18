import path from "path"
import { projectDataDir } from "@/storage/project-dir"
import { createHash } from "crypto"
import { readdir, readFile, stat } from "fs/promises"
import { fileURLToPath } from "url"
import {
  type ParseError as JsoncParseError,
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
} from "jsonc-parser"

import * as ConfigPaths from "@/config/paths"
import { Global } from "@/global"
import { Filesystem } from "@/util"
import { Flock } from "@duoduo-ai/shared/util/flock"
import { isRecord } from "@/util/record"

import { parsePluginSpecifier, readPackageThemes, readPluginPackage, resolvePluginTarget } from "./shared"

type Mode = "noop" | "add" | "replace"
type Kind = "server" | "tui"

export type Target = {
  kind: Kind
  opts?: Record<string, unknown>
}

export type InstallDeps = {
  resolve: (spec: string) => Promise<string>
  /**
   * E-01 (plugin integrity): expected SHA-256 of the resolved plugin package.
   * When provided, `installPlugin` verifies the computed checksum and refuses
   * the install (fail-closed) on mismatch. Operators pin a known-good checksum
   * to detect registry compromise / version confusion.
   */
  expectedIntegrity?: string
  /**
   * E-01: by default any plugin that declares `preinstall`/`install`/
   * `postinstall` lifecycle scripts is refused, because those scripts execute
   * with full host privileges during `Npm.add` reify. Set `true` only after
   * manually reviewing the scripts.
   */
  allowScripts?: boolean
}

/**
 * E-01: paths/artifacts excluded from the integrity checksum. `node_modules`
 * (transitive deps) and lockfiles are excluded so the checksum pins the
 * plugin's *own* source deterministically, independent of dependency tree
 * churn. `.duoduo` is the local plugin-config dir, not part of the package.
 */
const INTEGRITY_EXCLUDES = new Set([
  "node_modules",
  ".git",
  ".duoduo",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
])

/**
 * E-01: lifecycle scripts that run with full host privileges during install.
 * These are the classic RCE vectors for malicious npm packages.
 */
const DANGEROUS_SCRIPTS = ["preinstall", "install", "postinstall"] as const

/**
 * Compute a deterministic SHA-256 over a plugin package's own source files.
 * Files are hashed in a stable order (sorted by relative path) so the result
 * is reproducible across machines.
 */
async function checksumPackage(root: string): Promise<string> {
  const hash = createHash("sha256")
  const entries: Array<{ rel: string; abs: string }> = []

  async function walk(current: string): Promise<void> {
    let list: import("fs").Dirent[]
    try {
      list = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of list) {
      if (INTEGRITY_EXCLUDES.has(entry.name)) continue
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.isFile()) {
        entries.push({ rel: path.relative(root, abs), abs })
      }
    }
  }

  await walk(root)
  entries.sort((a, b) => a.rel.localeCompare(b.rel))
  for (const { rel, abs } of entries) {
    hash.update(rel)
    hash.update(await readFile(abs))
  }
  return hash.digest("hex")
}

function detectInstallScripts(json: Record<string, unknown>): string[] {
  if (!isRecord(json.scripts)) return []
  const scripts = json.scripts as Record<string, unknown>
  return DANGEROUS_SCRIPTS.filter(
    (key) => typeof scripts[key] === "string" && String(scripts[key]).trim().length > 0,
  )
}

type SafetyResult =
  | { ok: true; checksum: string }
  | { ok: false; code: "integrity_mismatch" | "install_script_blocked"; error: Error }

/**
 * E-01: verify plugin integrity before it is trusted/registered.
 *
 * - Computes a deterministic checksum of the resolved package.
 * - If `expectedIntegrity` is set, fails closed on mismatch.
 * - Unless `allowScripts` is set, refuses plugins that declare
 *   `preinstall`/`install`/`postinstall` scripts (RCE risk).
 *
 * This runs after `resolve` but before the package is written into plugin
 * config, so a compromised/malicious package is never activated.
 */
export async function verifyPluginSafety(
  spec: string,
  target: string,
  dep: InstallDeps,
): Promise<SafetyResult> {
  const filePath = target.startsWith("file://") ? fileURLToPath(target) : target
  const info = await stat(filePath).catch(() => undefined)
  const root = info?.isDirectory() ? filePath : path.dirname(filePath)

  const checksum = await checksumPackage(root).catch(() => "")

  // P1-14: fail closed when the caller DECLARED an integrity to verify but the
  // checksum could not be computed (IO error, unreadable files). The old
  // `expectedIntegrity && checksum` short-circuit silently skipped verification
  // in exactly the situation verification matters.
  if (dep.expectedIntegrity && !checksum) {
    return {
      ok: false,
      code: "integrity_mismatch",
      error: new Error(
        `Plugin "${spec}" integrity could not be verified: checksum computation failed. Install refused (fail-closed).`,
      ),
    }
  }

  if (dep.expectedIntegrity && checksum) {
    if (checksum.toLowerCase() !== dep.expectedIntegrity.toLowerCase()) {
      return {
        ok: false,
        code: "integrity_mismatch",
        error: new Error(
          `Plugin "${spec}" checksum mismatch: expected ${dep.expectedIntegrity}, got ${checksum}`,
        ),
      }
    }
  }

  if (!dep.allowScripts) {
    const json = await readPluginPackage(target).then((p) => p.json).catch(() => undefined)
    if (json) {
      const scripts = detectInstallScripts(json)
      if (scripts.length) {
        return {
          ok: false,
          code: "install_script_blocked",
          error: new Error(
            `Plugin "${spec}" declares lifecycle scripts (${scripts.join(
              ", ",
            )}) that run with full host privileges. Review the package and re-run with explicit script approval.`,
          ),
        }
      }
    }
  }

  return { ok: true, checksum }
}

export type PatchDeps = {
  readText: (file: string) => Promise<string>
  write: (file: string, text: string) => Promise<void>
  exists: (file: string) => Promise<boolean>
  files: (dir: string, name: "duoduo-ai" | "tui") => string[]
}

export type PatchInput = {
  spec: string
  targets: Target[]
  force?: boolean
  global?: boolean
  vcs?: string
  worktree: string
  directory: string
  config?: string
}

type Ok<T> = {
  ok: true
} & T

type Err<C extends string, T> = {
  ok: false
  code: C
} & T

export type InstallResult =
  | Ok<{ target: string; checksum?: string }>
  | Err<"install_failed", { error: unknown }>
  | Err<"integrity_mismatch", { error: unknown }>
  | Err<"install_script_blocked", { error: unknown }>

export type ManifestResult =
  | Ok<{ targets: Target[] }>
  | Err<"manifest_read_failed", { file: string; error: unknown }>
  | Err<"manifest_no_targets", { file: string }>

export type PatchItem = {
  kind: Kind
  mode: Mode
  file: string
}

type PatchErr =
  | Err<"invalid_json", { kind: Kind; file: string; line: number; col: number; parse: string }>
  | Err<"patch_failed", { kind: Kind; error: unknown }>

type PatchOne = Ok<{ item: PatchItem }> | PatchErr

export type PatchResult = Ok<{ dir: string; items: PatchItem[] }> | (PatchErr & { dir: string })

const defaultInstallDeps: InstallDeps = {
  resolve: (spec) => resolvePluginTarget(spec),
}

const defaultPatchDeps: PatchDeps = {
  readText: (file) => Filesystem.readText(file),
  write: async (file, text) => {
    await Filesystem.write(file, text)
  },
  exists: (file) => Filesystem.exists(file),
  files: (dir, name) => ConfigPaths.fileInDirectory(dir, name),
}

function pluginSpec(item: unknown) {
  if (typeof item === "string") return item
  if (!Array.isArray(item)) return
  if (typeof item[0] !== "string") return
  return item[0]
}

function pluginList(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return
  const item = data as { plugin?: unknown }
  if (!Array.isArray(item.plugin)) return
  return item.plugin
}

function exportValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const next = value.trim()
    if (next) return next
    return
  }
  if (!isRecord(value)) return
  for (const key of ["import", "default"]) {
    const next = value[key]
    if (typeof next !== "string") continue
    const hit = next.trim()
    if (!hit) continue
    return hit
  }
}

function exportOptions(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return
  const config = value.config
  if (!isRecord(config)) return
  return config
}

function exportTarget(pkg: Record<string, unknown>, kind: Kind) {
  const exports = pkg.exports
  if (!isRecord(exports)) return
  const value = exports[`./${kind}`]
  const entry = exportValue(value)
  if (!entry) return
  return {
    opts: exportOptions(value),
  }
}

function hasMainTarget(pkg: Record<string, unknown>) {
  const main = pkg.main
  if (typeof main !== "string") return false
  return Boolean(main.trim())
}

function packageTargets(pkg: { json: Record<string, unknown>; dir: string; pkg: string }) {
  const spec =
    typeof pkg.json.name === "string" && pkg.json.name.trim().length > 0 ? pkg.json.name.trim() : path.basename(pkg.dir)
  const targets: Target[] = []
  const server = exportTarget(pkg.json, "server")
  if (server) {
    targets.push({ kind: "server", opts: server.opts })
  } else if (hasMainTarget(pkg.json)) {
    targets.push({ kind: "server" })
  }

  const tui = exportTarget(pkg.json, "tui")
  if (tui) {
    targets.push({ kind: "tui", opts: tui.opts })
  }

  if (!targets.some((item) => item.kind === "tui") && readPackageThemes(spec, pkg).length) {
    targets.push({ kind: "tui" })
  }

  return targets
}

function patch(text: string, path: Array<string | number>, value: unknown, insert = false) {
  return applyEdits(
    text,
    modify(text, path, value, {
      formattingOptions: {
        tabSize: 2,
        insertSpaces: true,
      },
      isArrayInsertion: insert,
    }),
  )
}

function patchPluginList(
  text: string,
  list: unknown[] | undefined,
  spec: string,
  next: unknown,
  force = false,
): { mode: Mode; text: string } {
  const pkg = parsePluginSpecifier(spec).pkg
  const rows = (list ?? []).map((item, i) => ({
    item,
    i,
    spec: pluginSpec(item),
  }))
  const dup = rows.filter((item) => {
    if (!item.spec) return false
    if (item.spec === spec) return true
    if (item.spec.startsWith("file://")) return false
    return parsePluginSpecifier(item.spec).pkg === pkg
  })

  if (!dup.length) {
    if (!list) {
      return {
        mode: "add",
        text: patch(text, ["plugin"], [next]),
      }
    }
    return {
      mode: "add",
      text: patch(text, ["plugin", list.length], next, true),
    }
  }

  if (!force) {
    return {
      mode: "noop",
      text,
    }
  }

  const keep = dup[0]
  if (!keep) {
    return {
      mode: "noop",
      text,
    }
  }

  if (dup.length === 1 && keep.spec === spec) {
    return {
      mode: "noop",
      text,
    }
  }

  let out = text
  if (typeof keep.item === "string") {
    out = patch(out, ["plugin", keep.i], next)
  }
  if (Array.isArray(keep.item) && typeof keep.item[0] === "string") {
    out = patch(out, ["plugin", keep.i, 0], spec)
  }

  const del = dup
    .map((item) => item.i)
    .filter((i) => i !== keep.i)
    .sort((a, b) => b - a)

  for (const i of del) {
    out = patch(out, ["plugin", i], undefined)
  }

  return {
    mode: "replace",
    text: out,
  }
}

export async function installPlugin(
  spec: string,
  dep: Partial<InstallDeps> = {},
): Promise<InstallResult> {
  const resolvedDep: InstallDeps = { ...defaultInstallDeps, ...dep }
  const target = await resolvedDep.resolve(spec).then(
    (item) => ({
      ok: true as const,
      item,
    }),
    (error: unknown) => ({
      ok: false as const,
      error,
    }),
  )
  if (!target.ok) {
    return {
      ok: false,
      code: "install_failed",
      error: target.error,
    }
  }

  // E-01: verify integrity (checksum pin + install-script guard) before the
  // package is trusted/registered. Fails closed on mismatch or dangerous
  // lifecycle scripts, so a compromised plugin is never activated.
  const safety = await verifyPluginSafety(spec, target.item, resolvedDep)
  if (!safety.ok) {
    return {
      ok: false,
      code: safety.code,
      error: safety.error,
    }
  }

  return {
    ok: true,
    target: target.item,
    checksum: safety.checksum,
  }
}

export async function readPluginManifest(target: string): Promise<ManifestResult> {
  const pkg = await readPluginPackage(target).then(
    (item) => ({
      ok: true as const,
      item,
    }),
    (error: unknown) => ({
      ok: false as const,
      error,
    }),
  )
  if (!pkg.ok) {
    return {
      ok: false,
      code: "manifest_read_failed",
      file: target,
      error: pkg.error,
    }
  }

  const targets = await Promise.resolve()
    .then(() => packageTargets(pkg.item))
    .then(
      (item) => ({ ok: true as const, item }),
      (error: unknown) => ({ ok: false as const, error }),
    )

  if (!targets.ok) {
    return {
      ok: false,
      code: "manifest_read_failed",
      file: pkg.item.pkg,
      error: targets.error,
    }
  }

  if (!targets.item.length) {
    return {
      ok: false,
      code: "manifest_no_targets",
      file: pkg.item.pkg,
    }
  }

  return {
    ok: true,
    targets: targets.item,
  }
}

function patchDir(input: PatchInput) {
  if (input.global) return input.config ?? Global.Path.config
  const git = input.vcs === "git" && input.worktree !== "/"
  const root = git ? input.worktree : input.directory
  return projectDataDir(root)
}

function patchName(kind: Kind): "duoduo-ai" | "tui" {
  if (kind === "server") return "duoduo-ai"
  return "tui"
}

async function patchOne(dir: string, target: Target, spec: string, force: boolean, dep: PatchDeps): Promise<PatchOne> {
  const name = patchName(target.kind)
  await using _ = await Flock.acquire(`plug-config:${Filesystem.resolve(path.join(dir, name))}`)

  const files = dep.files(dir, name)
  let cfg = files[0]!
  for (const file of files) {
    if (!(await dep.exists(file))) continue
    cfg = file
    break
  }

  const src = await dep.readText(cfg).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "{}"
    return err
  })
  if (src instanceof Error) {
    return {
      ok: false,
      code: "patch_failed",
      kind: target.kind,
      error: src,
    }
  }
  const text = src.trim() ? src : "{}"

  const errs: JsoncParseError[] = []
  const data = parseJsonc(text, errs, { allowTrailingComma: true })
  if (errs.length) {
    const err = errs[0]!
    const lines = text.substring(0, err.offset).split("\n")
    return {
      ok: false,
      code: "invalid_json",
      kind: target.kind,
      file: cfg,
      line: lines.length,
      col: lines[lines.length - 1]!.length + 1,
      parse: printParseErrorCode(err.error),
    }
  }

  const list = pluginList(data)
  const item = target.opts ? ([spec, target.opts] as const) : spec
  const out = patchPluginList(text, list, spec, item, force)
  if (out.mode === "noop") {
    return {
      ok: true,
      item: {
        kind: target.kind,
        mode: out.mode,
        file: cfg,
      },
    }
  }

  const write = await dep.write(cfg, out.text).catch((error: unknown) => error)
  if (write instanceof Error) {
    return {
      ok: false,
      code: "patch_failed",
      kind: target.kind,
      error: write,
    }
  }

  return {
    ok: true,
    item: {
      kind: target.kind,
      mode: out.mode,
      file: cfg,
    },
  }
}

export async function patchPluginConfig(input: PatchInput, dep: PatchDeps = defaultPatchDeps): Promise<PatchResult> {
  const dir = patchDir(input)
  const items: PatchItem[] = []
  for (const target of input.targets) {
    const hit = await patchOne(dir, target, input.spec, Boolean(input.force), dep)
    if (!hit.ok) {
      return {
        ...hit,
        dir,
      }
    }
    items.push(hit.item)
  }
  return {
    ok: true,
    dir,
    items,
  }
}
