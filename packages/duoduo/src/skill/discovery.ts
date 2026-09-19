import { NodePath } from "@effect/platform-node"
import { Effect, Layer, Path, Schema, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { Global } from "../global"
import { Log } from "../util"

const skillConcurrency = 4
const fileConcurrency = 8

// Legacy skill index entry (pre-智械): `{ name, files }` with a SKILL.md marker.
class IndexSkill extends Schema.Class<IndexSkill>("IndexSkill")({
  name: Schema.String,
  files: Schema.Array(Schema.String),
}) {}

// Canonical 智械 (IntelGear) index entry, mirroring the Rust `GearIndexSource`
// `entries` schema (the runtime source of truth). Gear packs live under
// `gears/<name>/` in the registry repo (Zed-style: repo = registry, raw = CDN).
class IndexGear extends Schema.Class<IndexGear>("IndexGear")({
  name: Schema.String,
  kind: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  author: Schema.optional(Schema.String),
  spec: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
  homepage: Schema.optional(Schema.String),
  license: Schema.optional(Schema.String),
  activation: Schema.optional(Schema.String),
  // File paths (relative to `gears/<name>/`) to download. Defaults to
  // manifest.toml + instructions.md when omitted.
  files: Schema.optional(Schema.Array(Schema.String)),
}) {}

// Unified index: prefers `entries` (智械), falls back to legacy `skills`.
class Index extends Schema.Class<Index>("Index")({
  entries: Schema.optional(Schema.Array(IndexGear)),
  skills: Schema.optional(Schema.Array(IndexSkill)),
}) {}

// Internal normalized shape: name + base-relative dir + files + marker file.
interface NormalizedEntry {
  name: string
  // Directory prefix inside the registry (e.g. "gears/duoduo-git" or "duoduo-git").
  dir: string
  files: string[]
  // The file whose presence confirms a valid install (manifest.toml or SKILL.md).
  marker: string
}

// P0-6: registry-supplied names/paths are UNTRUSTED input (index.json comes
// from a remote registry). Reject anything that could escape the cache dir —
// absolute paths, Windows drive letters, ".." segments — before it reaches
// path.join/download.
const SAFE_ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function isSafeEntryName(name: string): boolean {
  return SAFE_ENTRY_NAME.test(name)
}

function isSafeRelPath(p: string): boolean {
  if (p.length === 0) return false
  const n = p.replaceAll("\\", "/")
  if (n.startsWith("/") || /^[A-Za-z]:/.test(n)) return false
  return !n.split("/").some((seg) => seg === "..")
}

export interface Interface {
  readonly pull: (url: string) => Effect.Effect<string[], unknown, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/SkillDiscovery") {}

export const layer: Layer.Layer<Service, never, AppFileSystem.Service | Path.Path | HttpClient.HttpClient> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const log = Log.create({ service: "skill-discovery" })
      const fs = yield* AppFileSystem.Service
      const path = yield* Path.Path
      const http = HttpClient.filterStatusOk(withTransientReadRetry(yield* HttpClient.HttpClient))
      const cache = path.join(Global.Path.cache, "skills")

      const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

      const download = Effect.fn("Discovery.download")(function* (url: string, dest: string) {
        // Check cache TTL: if the file exists and was cached recently, skip download
        if (yield* fs.exists(dest).pipe(Effect.orDie)) {
          const metaPath = dest + ".cache-meta.json"
          const metaExists = yield* fs.exists(metaPath).pipe(Effect.catch(() => Effect.succeed(false)))
          if (metaExists) {
// @effect-diagnostics-next-line tryCatchInEffectGen:off
            try {
              const metaContent = yield* fs.readFileString(metaPath)
// @effect-diagnostics-next-line preferSchemaOverJson:off
              const meta = JSON.parse(metaContent)
              if (meta.cachedAt && Date.now() - meta.cachedAt < CACHE_TTL_MS) {
                return true // Cache hit, skip download
              }
            } catch {
              // Invalid meta file, re-download
            }
          } else {
            // File exists but no meta — treat as fresh (backward compat)
            return true
          }
        }

        // Download fresh copy
        return yield* HttpClientRequest.get(url).pipe(
          http.execute,
          Effect.flatMap((res) => res.arrayBuffer),
          Effect.flatMap((body) => fs.writeWithDirs(dest, new Uint8Array(body))),
          // Write cache meta
          Effect.tap(() =>
            fs
              .writeWithDirs(
                dest + ".cache-meta.json",
                new TextEncoder().encode(JSON.stringify({ cachedAt: Date.now(), url })),
              )
              .pipe(Effect.catch(() => Effect.void)),
          ),
          Effect.as(true),
          Effect.catch((err) =>
            Effect.sync(() => {
              log.error("failed to download", { url, err })
              return false
            }),
          ),
        )
      })

      const pull = Effect.fn("Discovery.pull")(function* (url: string) {
        const base = url.endsWith("/") ? url : `${url}/`
        const index = new URL("index.json", base).href
        const host = base.slice(0, -1)

        log.info("fetching index", { url: index })

        const data = yield* HttpClientRequest.get(index).pipe(
          HttpClientRequest.acceptJson,
          http.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Index)),
          Effect.catch((err) =>
            Effect.sync(() => {
              log.error("failed to fetch index", { url: index, err })
              return null
            }),
          ),
        )

        if (!data) return []

        // Normalize both index shapes into a single list. Prefer 智械 `entries`;
        // fall back to legacy `skills`. An empty result means the index is invalid.
        const normalized: NormalizedEntry[] = []
        if (data.entries && data.entries.length > 0) {
          for (const gear of data.entries) {
            if (!isSafeEntryName(gear.name)) {
              log.warn("gear entry has unsafe name, skipped", { url: index, name: gear.name })
              continue
            }
            const rawFiles = gear.files && gear.files.length > 0 ? [...gear.files] : ["manifest.toml", "instructions.md"]
            const files = rawFiles.filter((f) => {
              if (isSafeRelPath(f)) return true
              log.warn("gear file path unsafe, skipped", { url: index, gear: gear.name, file: f })
              return false
            })
            if (files.length === 0) {
              log.warn("gear entry has no safe files, skipped", { url: index, name: gear.name })
              continue
            }
            // A gear is valid if it ships a manifest.toml (智械 marker) — otherwise
            // it degrades to an instructions-only pack keyed on instructions.md.
            const marker = files.includes("manifest.toml")
              ? "manifest.toml"
              : files.includes("SKILL.md")
                ? "SKILL.md"
                : "instructions.md"
            normalized.push({ name: gear.name, dir: `gears/${gear.name}`, files, marker })
          }
        } else if (data.skills && data.skills.length > 0) {
          for (const skill of data.skills) {
            if (!isSafeEntryName(skill.name)) {
              log.warn("skill entry has unsafe name, skipped", { url: index, name: skill.name })
              continue
            }
            if (!skill.files.includes("SKILL.md")) {
              log.warn("skill entry missing SKILL.md", { url: index, skill: skill.name })
              continue
            }
            const files = skill.files.filter((f) => {
              if (isSafeRelPath(f)) return true
              log.warn("skill file path unsafe, skipped", { url: index, skill: skill.name, file: f })
              return false
            })
            if (!files.includes("SKILL.md")) {
              log.warn("skill entry lost SKILL.md after path check, skipped", { url: index, skill: skill.name })
              continue
            }
            normalized.push({ name: skill.name, dir: skill.name, files, marker: "SKILL.md" })
          }
        }

        const dirs = yield* Effect.forEach(
          normalized,
          (entry) =>
            Effect.gen(function* () {
              const root = path.join(cache, entry.name)

              const results = yield* Effect.forEach(
                entry.files,
                (file) => download(new URL(file, `${host}/${entry.dir}/`).href, path.join(root, file)),
                {
                  concurrency: fileConcurrency,
                },
              )

              // B10: a partial download (any file failed) must not be treated
              // as a valid gear — the marker alone would let an incomplete
              // pack (missing tools/mcp.json or instructions.md) install.
              if (results.some((ok) => !ok)) {
                log.warn("gear download incomplete, skipped", { url: index, skill: entry.name })
                yield* fs.remove(root, { recursive: true, force: true }).pipe(Effect.catch(() => Effect.void))
                return null
              }

              const markerPath = path.join(root, entry.marker)
              return (yield* fs.exists(markerPath).pipe(Effect.orDie)) ? root : null
            }),
          { concurrency: skillConcurrency },
        )

        return dirs.filter((dir): dir is string => dir !== null)
      })

      return Service.of({ pull })
    }),
  )

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(NodePath.layer),
)

export * as Discovery from "./discovery"
