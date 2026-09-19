import { test, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import { Effect } from "effect"
import { Snapshot } from "../../src/snapshot"
import { Instance } from "../../src/project/instance"
import { Filesystem } from "../../src/util"
import { provideInstance, tmpdir, testProjectInfo } from "../fixture/fixture"
import { disposeAllWithTimeout } from "../lib/dispose"

// P2-13 (10-3): `snapshot_max_file_size` is user-controllable — the live
// reader (not a module constant) decides which untracked files participate
// in snapshots, so a lowered cap excludes files the 2MB default would take.
test("snapshot_max_file_size setting drives per-file exclusion", async () => {
  await using tmp = await tmpdir({
    git: true,
    // The fixture writes this into the project config file the Config service
    // discovers — the live reader must pick the lowered cap up.
    config: { snapshot_max_file_size: 100 },
    init: async (dir) => {
      await Filesystem.write(`${dir}/a.txt`, "small")
      await $`git add .`.cwd(dir).quiet()
      await $`git commit -m init`.cwd(dir).quiet()
      return {}
    },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const writeBigUntracked = async () => {
          // 300 bytes of untracked content — over the 100-byte cap, under the
          // 2MB default (so only the setting can explain the exclusion).
          await Filesystem.write(`${tmp.path}/big.txt`, "x".repeat(300))
          await Filesystem.write(`${tmp.path}/small.txt`, "ok")
        }
        await writeBigUntracked()

        const run = <A>(body: (snapshot: Snapshot.Interface) => Effect.Effect<A>) => {
          const { project, worktree } = testProjectInfo(tmp.path, true)
          return Effect.runPromise(
            Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              return yield* body(snapshot)
            }).pipe(provideInstance(tmp.path, project, worktree), Effect.provide(Snapshot.defaultLayer)),
          )
        }

        // First snapshot includes small.txt (under cap); big.txt is excluded.
        const hash1 = await run((snapshot) => snapshot.track())
        expect(hash1).toBeTruthy()

        // Deleting small.txt after the snapshot: the patch computed against
        // hash1 reports the snapshotted deletion — and only that one. big.txt
        // was never snapshotted, so it must not appear in the patch.
        await fs.rm(`${tmp.path}/small.txt`)
        const patch = await run((snapshot) => snapshot.patch(hash1!))
        expect(patch.files).toContain(`${tmp.path}/small.txt`)
        expect(patch.files).not.toContain(`${tmp.path}/big.txt`)

        // Rolling back to hash1 restores small.txt and must NOT delete the
        // excluded big.txt (never snapshotted ⇒ never deleted on rollback).
        // force=true: the oversized untracked file counts as worktree drift
        // for the S-02 gate (known boundary), but the E1 cleanup still
        // preserves it via the same size cap.
        const restore = await run((snapshot) => snapshot.restore(hash1!, true))
        expect(restore.failed).toEqual([])
        await expect(fs.access(`${tmp.path}/big.txt`)).resolves.toBeFalsy()
        await expect(fs.access(`${tmp.path}/small.txt`)).resolves.toBeFalsy()
      },
    })
  } finally {
    await disposeAllWithTimeout()
  }
})
