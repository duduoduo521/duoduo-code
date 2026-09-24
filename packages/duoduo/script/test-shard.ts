#!/usr/bin/env bun
// Split the duoduo unit-test suite into N deterministic shards so CI can run
// them as parallel jobs.
//
// Why: the serial suite takes ~40min on a CI runner and kept dying mid-run to
// runner-level teardowns (2026-09-18/22/23: exit 143 "runner has received a
// shutdown signal", zero test failures, death point moves each time). Shorter
// shards = smaller exposure window per VM, and one dead runner only costs a
// single ~15min shard re-run instead of the whole pass.
//
// Usage:
//   bun run script/test-shard.ts --shard 1 --total 3          # run shard 1/3
//   bun run script/test-shard.ts --list --total 3             # print split, run nothing
//   SHARD_INDEX / SHARD_TOTAL env vars are also accepted.
//
// Splitting is round-robin over the sorted file list (not contiguous chunks)
// so slow directories scattered across the alphabet stay balanced.

import { mkdirSync } from "node:fs"

const args = process.argv.slice(2)
function argOf(flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const listOnly = args.includes("--list")
const total = Number(argOf("--total") ?? process.env.SHARD_TOTAL ?? 3)
const shard = Number(argOf("--shard") ?? process.env.SHARD_INDEX ?? 1)

if (!Number.isInteger(total) || total < 1) throw new Error(`invalid --total: ${total}`)
if (!Number.isInteger(shard) || shard < 1 || shard > total) throw new Error(`invalid --shard: ${shard} (must be 1..${total})`)

const found = await Array.fromAsync(new Bun.Glob("**/*.test.ts").scan({ cwd: "test", onlyFiles: true }))
const files = [...found].map((p) => "test/" + p.replaceAll("\\", "/")).sort()
if (files.length === 0) throw new Error("no test files found under test/")

const mine = files.filter((_, i) => i % total === shard - 1)

if (listOnly) {
  for (const f of mine) console.log(f)
  console.error(`shard ${shard}/${total}: ${mine.length}/${files.length} files`)
  process.exit(0)
}

console.log(`shard ${shard}/${total}: running ${mine.length}/${files.length} test files`)

mkdirSync(".artifacts/unit", { recursive: true })

const proc = Bun.spawn(
  [
    "bun",
    "test",
    ...mine,
    "--timeout",
    "60000",
    "--isolate",
    "--max-concurrency=1",
    "--reporter=junit",
    "--reporter-outfile=.artifacts/unit/junit.xml",
  ],
  { stdout: "inherit", stderr: "inherit", stdin: "inherit" },
)

process.exit(await proc.exited)
