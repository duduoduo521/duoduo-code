import { describe, test, expect } from "bun:test"
import * as path from "path"
import * as NFS from "fs"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import * as FileDelete from "../../src/file/delete"
import { tmpdir } from "../fixture/fixture"

const layer = AppFileSystem.layer.pipe(Layer.provide(NodeFileSystem.layer))

const removeBatched = (root: string) =>
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    return yield* FileDelete.removeBatched(fs, root)
  }).pipe(Effect.provide(layer))

const remove = (target: string, isDirectory: boolean) =>
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    return yield* FileDelete.remove(fs, target, isDirectory)
  }).pipe(Effect.provide(layer))

const exists = (p: string) => NFS.existsSync(p)

function makeTree(root: string, dirs: number, filesPerDir: number) {
  NFS.mkdirSync(path.join(root, "empty"), { recursive: true })
  NFS.writeFileSync(path.join(root, "top.txt"), "x")
  for (let d = 0; d < dirs; d++) {
    const dir = path.join(root, "a", "b", `d${d}`)
    NFS.mkdirSync(dir, { recursive: true })
    for (let f = 0; f < filesPerDir; f++) NFS.writeFileSync(path.join(dir, `f${f}.txt`), "x")
  }
}

describe("file/delete", () => {
  test("removeBatched deletes files, nested directories and empty directories", async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "tree")
    makeTree(root, 2, 2)

    await Effect.runPromise(removeBatched(root))

    expect(exists(root)).toBe(false)
  })

  test("removeBatched paces large trees and skips pacing for small ones", async () => {
    await using tmp = await tmpdir()
    const small = path.join(tmp.path, "small")
    makeTree(small, 1, 2)
    const big = path.join(tmp.path, "big")
    makeTree(big, 4, 90) // > PACING_SMALL_TREE entries

    const startedSmall = Date.now()
    await Effect.runPromise(removeBatched(small))
    const smallMs = Date.now() - startedSmall

    const startedBig = Date.now()
    await Effect.runPromise(removeBatched(big))
    const bigMs = Date.now() - startedBig

    expect(exists(small)).toBe(false)
    expect(exists(big)).toBe(false)
    // The big tree must pay at least one pacing pause; the small one pays none.
    expect(bigMs - smallMs).toBeGreaterThanOrEqual(FileDelete.PACING_PAUSE_MS)
  })

  test("remove() reports recycle usage and the target is gone", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "recycle-dir")
    NFS.mkdirSync(path.join(dir, "nested"), { recursive: true })
    NFS.writeFileSync(path.join(dir, "nested", "f.txt"), "x")

    const result = await Effect.runPromise(remove(dir, true))

    expect(exists(dir)).toBe(false)
    expect(result.recycled).toBe(process.platform === "win32")
  })

  test("remove() deletes a single file", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "recycle-file.txt")
    NFS.writeFileSync(file, "x")

    const result = await Effect.runPromise(remove(file, false))

    expect(exists(file)).toBe(false)
    expect(result.recycled).toBe(process.platform === "win32")
  })

  test("recycle() returns false instead of failing when the shell API refuses", async () => {
    await using tmp = await tmpdir()
    expect(await Effect.runPromise(FileDelete.recycle(path.join(tmp.path, "does-not-exist-xyz"), true))).toBe(
      false,
    )
  })
})
