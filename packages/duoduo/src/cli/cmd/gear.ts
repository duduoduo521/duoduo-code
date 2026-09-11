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

// Copy a Discovery-cached dir into the local gear store (idempotent).
async function installFromCacheDir(cacheDir: string, name: string): Promise<string> {
  const dest = path.join(GEAR_STORE, name)
  await fs.rm(dest, { recursive: true, force: true })
  await fs.cp(cacheDir, dest, { recursive: true })
  return dest
}

async function listInstalled(): Promise<string[]> {
  await ensureStore()
  const entries = await fs.readdir(GEAR_STORE, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory()).map((e) => e.name)
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
          prompts.log.info("Install one with: duoduo gear install <name> <url>")
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
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        const name = args.name
        const url = args.url
        if (!name || !url) {
          prompts.log.error("usage: duoduo gear install <name> <url>")
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
          prompts.outro("Done")
        }
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
          prompts.log.error("usage: duoduo gear create <name>")
          return
        }
        UI.empty()
        prompts.intro(`Create 智械: ${name}`)

        const targetDir = args.path ? path.resolve(args.path, name) : path.resolve(process.cwd(), name)

        if (await Filesystem.exists(targetDir)) {
          prompts.log.error(`Target already exists: ${targetDir}`)
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
      .command(GearCreateCommand)
      .demandCommand(),
  async handler() {},
})
