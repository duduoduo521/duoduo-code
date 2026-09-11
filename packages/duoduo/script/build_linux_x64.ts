#!/usr/bin/env bun
import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

await import("./generate.ts")

import { Script } from "@duoduo-ai/script"
import pkg from "../package.json"

const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = true

const name = "duoduo-linux-x64"
console.log(`building ${name} for bun-linux-x64`)

await $`rm -rf dist/${name}`
await $`mkdir -p dist/${name}/bin`

const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
const rootPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
const workerPath = "./src/cli/cmd/tui/worker.ts"
const bunfsRoot = "/$bunfs/root/"
const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

const result = await Bun.build({
  conditions: ["browser"],
  tsconfig: "./tsconfig.json",
  plugins: [plugin],
  external: ["node-gyp", "cpu-features"],
  format: "esm",
  minify: true,
  splitting: false,
  bytecode: true,
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    target: "bun-linux-x64" as any,
    outfile: `dist/${name}/bin/duoduocode`,
    execArgv: [`--user-agent=DuoDuoCode/${Script.version}`, "--use-system-ca", "--"],
  },
  entrypoints: ["./src/index.ts", parserWorker, workerPath],
  define: {
    DUODUO_VERSION: `'${Script.version}'`,
    DUODUO_MIGRATIONS: JSON.stringify(migrations),
    OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
    DUODUO_WORKER_PATH: workerPath,
    DUODUO_CHANNEL: `'${Script.channel}'`,
    DUODUO_LIBC: `'glibc'`,
  },
})

if (!result.success) {
  console.error("BUILD FAILED")
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

await $`rm -rf ./dist/${name}/bin/tui`
await Bun.file(`dist/${name}/package.json`).write(
  JSON.stringify({ name, version: Script.version, os: ["linux"], cpu: ["x64"] }, null, 2),
)
console.log("BUILD OK -> dist/" + name + "/bin/duoduocode")
