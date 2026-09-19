import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Config } from "../../src/config"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

test("config file discovery feeds snapshot settings", () =>
  testEffect(
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const dir = Instance.directory
        yield* Effect.promise(() => fs.mkdir(path.join(dir, ".duoduo"), { recursive: true }))
        yield* Effect.promise(() =>
          Bun.write(path.join(dir, ".duoduo/duoduo.json"), JSON.stringify({ snapshot_max_file_size: 100, snapshot_retention_days: 45 })),
        )
        const cfg = yield* Config.get()
        // In-repo `.duoduo/duoduo.json` must feed the snapshot settings
        // (the live readers in snapshot/index.ts read exactly these keys).
        expect(cfg.snapshot_max_file_size).toBe(100)
        expect(cfg.snapshot_retention_days).toBe(45)
      }),
    ),
  ),
)
