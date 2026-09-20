import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Global } from "../../global"
import { Filesystem } from "../../util"
import { Instance } from "../../project/instance"
import path from "path"
import fs from "fs/promises"
import { EOL } from "os"
import { AppRuntime } from "../../effect/app-runtime"
import { Discovery } from "../../skill/discovery"

// P5 — 智械 (IntelGear) marketplace + CLI.
//
// A 智械 is distributed as an entry in a `index.json` that reuses the exact same
// `Index` shape as skills (`skills: [{ name, files }]`); a gear's `files` simply
// additionally contain `manifest.toml`, `tools/*` and `strategies/*`. Old skill
// indexes (no gear fields) degrade to instructions-only 智械 — so we reuse
// `Discovery.pull` verbatim (download + 24h cache) and never write a second
// network layer. Gears pulled into the local store live under `data/gears`
// (user data, outside the cache dir so they survive app updates).

const GEAR_STORE = process.env.DUODUO_GEARS_DIR ? path.resolve(process.env.DUODUO_GEARS_DIR) : Global.Path.gears

async function ensureStore(): Promise<void> {
  await fs.mkdir(GEAR_STORE, { recursive: true })
}

// Pull a remote index and return the on-disk directories Discovery cached.
async function pullGears(url: string): Promise<string[]> {
  return AppRuntime.runPromise(Discovery.Service.use((disc) => disc.pull(url)))
}

// Copy a Discovery-cached dir into the local gear store.
// P1-12: rm-then-cp left the store broken when cp failed mid-way (old version
// already deleted, new one partially copied). Stage into a tmp dir first, then
// swap atomically; on Windows the rename to an existing dir fails, so rm the
// old one immediately before the rename (tiny window) with bounded retries.
async function installFromCacheDir(cacheDir: string, name: string): Promise<string> {
  const dest = path.join(GEAR_STORE, name)
  const tmp = `${dest}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await fs.cp(cacheDir, tmp, { recursive: true })
    await fs.rm(dest, { recursive: true, force: true })
    let renamed = false
    for (let attempt = 0; attempt < 3 && !renamed; attempt++) {
      try {
        await fs.rename(tmp, dest)
        renamed = true
      } catch (e) {
        if (attempt === 2) throw e
        await new Promise((r) => setTimeout(r, 200))
      }
    }
  } catch (e) {
    // Preserve the staged copy for diagnosis instead of leaving nothing
    // (audit fix: a cp-stage failure previously leaked the `.tmp-` dir).
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    const broken = `${dest}.broken-${Date.now()}`
    await fs.cp(cacheDir, broken, { recursive: true }).catch(() => {})
    throw new Error(
      `Gear install failed; the source copy was preserved at ${broken}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  return dest
}

// P1-12: remove a gear from the local store. The gear's MCP servers are
// loaded from `<GEAR_STORE>/<name>/tools/mcp.json` at sidecar load, so
// deleting the directory fully removes the gear (nothing else is persisted:
// gear install writes no plugin-config entries, npm packages, or metadata).
// A2: `name` comes straight from argv and is joined into an `rm -rf` target —
// validate it exactly like the desktop route's is_valid_name (gear.rs) so
// `gear uninstall ..` cannot delete arbitrary directories.
const GEAR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function assertValidGearName(name: string) {
  if (!GEAR_NAME_RE.test(name)) {
    throw new Error(`Invalid gear name "${name}": use letters, digits, "-" or "_" (no leading dot)`)
  }
}

async function uninstallGear(name: string): Promise<boolean> {
  assertValidGearName(name)
  const dest = path.join(GEAR_STORE, name)
  if (!(await Filesystem.exists(dest))) return false
  await fs.rm(dest, { recursive: true, force: true })
  // Best-effort: drop stale tmp/broken artifacts from interrupted installs.
  for (const suffix of [".tmp-", ".broken-"]) {
    try {
      const entries = await fs.readdir(GEAR_STORE, { withFileTypes: true })
      for (const e of entries) {
        if (e.isDirectory() && e.name.startsWith(`${name}${suffix}`)) {
          await fs.rm(path.join(GEAR_STORE, e.name), { recursive: true, force: true })
        }
      }
    } catch {
      // best-effort only
    }
  }
  return true
}

async function listInstalled(): Promise<string[]> {
  await ensureStore()
  const entries = await fs.readdir(GEAR_STORE, { withFileTypes: true })
  // A2 (域11-D2): interrupted installs leave `<name>.tmp-*` / `<name>.broken-*`
  // staging dirs — they are not installed gears and must never be listed
  // (or loaded: the Rust/TS MCP loaders get the same filter).
  return entries
    .filter((e) => e.isDirectory() && !e.name.includes(".tmp-") && !e.name.includes(".broken-"))
    .map((e) => e.name)
}

const GearSearchCommand = cmd({
  command: "search <url>",
  describe: "search the 智械 registry at <url> for available gears",
  builder: (yargs) =>
    yargs.positional("url", {
      type: "string",
      describe: "base URL of the 智械 registry (index.json is fetched from here)",
      demandOption: true,
    }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const url = args.url
        if (!url) {
          prompts.log.error("missing registry <url>")
          process.exitCode = 1
          return
        }
        UI.empty()
        prompts.intro("Search 智械 registry")

        const spinner = prompts.spinner()
        spinner.start(`Fetching index from ${url} ...`)
        try {
          const dirs = await pullGears(url)
          spinner.stop(`${dirs.length} gear(s) available`)
          if (dirs.length === 0) {
            prompts.log.warn("No gears found (registry entries may require a SKILL.md manifest).")
            prompts.outro("Done")
            return
          }
          for (const dir of dirs) {
            const name = path.basename(dir)
            prompts.log.info(`${name} ${UI.Style.TEXT_DIM}${dir}`)
          }
          prompts.outro(`${dirs.length} gear(s)`)
        } catch (error) {
          spinner.stop("Search failed", 1)
          prompts.log.error(error instanceof Error ? error.message : String(error))
          process.exitCode = 1
          prompts.outro("Done")
        }
      },
    })
  },
})

const GearListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list locally installed 智械 gears",
  async handler() {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("Installed 智械 gears")
        const gears = await listInstalled()
        if (gears.length === 0) {
          prompts.log.warn("No gears installed")
          prompts.log.info("Install one with: duoduocode gear install <name> <url>")
          prompts.outro("Done")
          return
        }
        for (const name of gears) {
          const manifest = path.join(GEAR_STORE, name, "manifest.toml")
          const hasManifest = await Filesystem.exists(manifest)
          prompts.log.info(`${name} ${UI.Style.TEXT_DIM}${hasManifest ? "manifest.toml present" : "no manifest"}`)
        }
        prompts.outro(`${gears.length} gear(s)`)
      },
    })
  },
})

const GearInstallCommand = cmd({
  command: "install <name> <url>",
  describe: "install a 智械 gear <name> from the registry at <url>",
  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "gear name (must match an entry in the registry index.json)",
        demandOption: true,
      })
      .positional("url", {
        type: "string",
        describe: "base URL of the 智械 registry",
        demandOption: true,
      })
      // C4: non-interactive environments (CI / piped input) cannot answer the
      // consent prompt — `--yes` skips it explicitly.
      .option("yes", {
        type: "boolean",
        describe: "skip the install confirmation prompt (non-interactive use)",
        default: false,
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const name = args.name
        const url = args.url
        if (!name || !url) {
          prompts.log.error("usage: duoduocode gear install <name> <url>")
          process.exitCode = 1
          return
        }
        UI.empty()
        prompts.intro(`Install 智械: ${name}`)

        const spinner = prompts.spinner()
        spinner.start(`Fetching index from ${url} ...`)
        try {
          const dirs = await pullGears(url)
          const match = dirs.find((d) => path.basename(d) === name)
          if (!match) {
            spinner.stop(`Gear "${name}" not found in registry`, 1)
            prompts.log.info(`Available: ${dirs.map((d) => path.basename(d)).join(", ") || "(none)"}`)
            prompts.outro("Done")
            // M8 (B11): a failed lookup must not exit 0 — scripts and CI
            // branches on the exit code.
            process.exitCode = 1
            return
          }
          // P0-6②: informed consent before the pack lands in the store —
          // show the file list and, if present, the command the gear's
          // tools/mcp.json will execute. The gear's MCP tools are spawned
          // when the sidecar loads, so consent must happen at install time.
          const files: string[] = []
          const walk = async (dir: string): Promise<void> => {
            for (const e of await fs.readdir(dir, { withFileTypes: true })) {
              const full = path.join(dir, e.name)
              if (e.isDirectory()) await walk(full)
              else files.push(path.relative(match, full))
            }
          }
          await walk(match)
          let commandNote = "(no tools/mcp.json — no command execution)"
          let envNote = ""
          const mcpJsonPath = path.join(match, "tools", "mcp.json")
          if (await Filesystem.exists(mcpJsonPath)) {
            try {
              const raw = JSON.parse(await fs.readFile(mcpJsonPath, "utf8")) as Record<string, unknown>
              commandNote =
                (raw.kind ?? "stdio") === "stdio" && typeof raw.command === "string"
                  ? `command: ${raw.command}${Array.isArray(raw.args) ? " " + raw.args.join(" ") : ""}`
                  : raw.kind === "sse" && typeof raw.url === "string"
                    ? `url: ${raw.url}`
                    : "(unrecognized tools/mcp.json)"
              // B9: env injection is part of what the user consents to — the
              // values are set into the MCP server's environment at spawn.
              if (raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)) {
                const envEntries = Object.entries(raw.env as Record<string, unknown>).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                )
                if (envEntries.length > 0) {
                  envNote = `env: ${envEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`
                }
              }
            } catch {
              commandNote = "(invalid tools/mcp.json)"
            }
          }
          prompts.log.info(`Files:\n  ${files.join("\n  ")}`)
          prompts.log.info(commandNote)
          if (envNote) prompts.log.info(envNote)
          // C4: `--yes` skips the consent prompt for non-interactive use; in
          // an interactive session the prompt always shows (informed consent,
          // P0-6②). A non-TTY run WITHOUT --yes fails instead of hanging.
          let ok: boolean | symbol
          if (args.yes) {
            prompts.log.info("(--yes) skipping confirmation")
            ok = true
          } else if (!process.stdin.isTTY) {
            prompts.log.error("Non-interactive environment: pass --yes to accept the install consent shown above")
            process.exitCode = 1
            spinner.stop("Install cancelled")
            prompts.outro("Done")
            return
          } else {
            ok = await prompts.confirm({ message: "Install this gear?" })
          }
          if (prompts.isCancel(ok) || !ok) {
            spinner.stop("Install cancelled")
            prompts.outro("Done")
            return
          }
          spinner.start(`Installing ${name} ...`)
          const dest = await installFromCacheDir(match, name)
          spinner.stop(`Installed ${name}`)
          prompts.log.success(`Gear installed: ${dest}`)
          prompts.outro("Done")
        } catch (error) {
          spinner.stop("Install failed", 1)
          prompts.log.error(error instanceof Error ? error.message : String(error))
          process.exitCode = 1
          prompts.outro("Done")
        }
      },
    })
  },
})

const GearUninstallCommand = cmd({
  command: "uninstall <name>",
  aliases: ["remove", "rm"],
  describe: "uninstall a locally installed 智械 gear <name>",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "gear name (as shown by `duoduocode gear list`)",
      demandOption: true,
    }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const name = args.name
        if (!name) {
          prompts.log.error("usage: duoduocode gear uninstall <name>")
          process.exitCode = 1
          return
        }
        UI.empty()
        prompts.intro(`Uninstall 智械: ${name}`)
        try {
          await ensureStore()
          const removed = await uninstallGear(name)
          if (removed) {
            prompts.log.success(`Gear uninstalled: ${name}`)
          } else {
            prompts.log.warn(`Gear "${name}" is not installed`)
            process.exitCode = 1
          }
        } catch (error) {
          prompts.log.error(error instanceof Error ? error.message : String(error))
          process.exitCode = 1
        }
        prompts.outro("Done")
      },
    })
  },
})

const GearCreateCommand = cmd({
  command: "create <name>",
  describe: "scaffold a new 智械 gear package",
  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "gear name (used as the package directory name)",
        demandOption: true,
      })
      .option("path", {
        type: "string",
        describe: "directory to generate the gear package into (defaults to ./<name>)",
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const name = args.name
        if (!name) {
          prompts.log.error("usage: duoduocode gear create <name>")
          process.exitCode = 1
          return
        }
        UI.empty()
        prompts.intro(`Create 智械: ${name}`)

        const targetDir = args.path ? path.resolve(args.path, name) : path.resolve(process.cwd(), name)

        if (await Filesystem.exists(targetDir)) {
          prompts.log.error(`Target already exists: ${targetDir}`)
          process.exitCode = 1
          prompts.outro("Done")
          return
        }

        const manifest = `# 智械 (IntelGear) manifest
name = "${name}"
version = "0.1.0"
# instructions / capabilities / tools / strategies are optional extension fields.
# Old skill indexes without these fields degrade to instructions-only 智械.
`

        const toolsDir = path.join(targetDir, "tools")
        const strategiesDir = path.join(targetDir, "strategies")
        const instructionsPath = path.join(targetDir, "instructions.md")

        await fs.mkdir(toolsDir, { recursive: true })
        await fs.mkdir(strategiesDir, { recursive: true })
        await Filesystem.write(path.join(targetDir, "manifest.toml"), manifest)
        await Filesystem.write(
          instructionsPath,
          `# Instructions for ${name}\n\nDescribe the capability this 智械 provides.\n`,
        )
        await Filesystem.write(
          path.join(toolsDir, "README.md"),
          `# Tools for ${name}\n\nPlace tool definitions here.\n`,
        )
        await Filesystem.write(
          path.join(strategiesDir, "README.md"),
          `# Strategies for ${name}\n\nPlace LoopStrategy definitions here.\n`,
        )

        prompts.log.success(`Gear scaffolded: ${targetDir}`)
        prompts.log.info(`  manifest.toml${EOL}  instructions.md${EOL}  tools/${EOL}  strategies/`)
        prompts.outro("Done")
      },
    })
  },
})

export const GearCommand = cmd({
  command: "gear",
  describe: "manage 智械 (IntelGear) capability packages",
  builder: (yargs) =>
    yargs
      .command(GearSearchCommand)
      .command(GearListCommand)
      .command(GearInstallCommand)
      .command(GearUninstallCommand)
      .command(GearCreateCommand)
      .demandCommand(),
  async handler() {},
})
