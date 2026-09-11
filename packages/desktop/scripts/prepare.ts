#!/usr/bin/env bun
import { $ } from "bun"

import { Script } from "@duoduo-ai/script"
import { copyBinaryToSidecarFolder, getCurrentSidecar, windowsify } from "./utils"

const BunGlobal = Bun
const pkg = (await BunGlobal.file("./package.json").json()) as { version: string }
pkg.version = Script.version
await BunGlobal.write("./package.json", JSON.stringify(pkg as Record<string, unknown>, null, 2) + "\n")
console.log(`Updated package.json version to ${Script.version}`)

const sidecarConfig = getCurrentSidecar()
const artifact = process.env.DUODUO_CLI_ARTIFACT ?? "duoduocode-cli"

const dir = "src-tauri/target/duoduocode-binaries"

await $`mkdir -p ${dir}`
await $`gh run download ${process.env.GITHUB_RUN_ID} -n ${artifact}`.cwd(dir)

await copyBinaryToSidecarFolder(windowsify(`${dir}/${sidecarConfig.ocBinary}/bin/duoduocode`))
