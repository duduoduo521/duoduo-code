import { afterEach, test, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { Snapshot } from "../../src/snapshot"
import { Instance } from "../../src/project/instance"
import { Filesystem } from "../../src/util"
import { provideInstance, tmpdir, testProjectInfo } from "../fixture/fixture"

// Git always outputs /-separated paths internally. Snapshot.patch() joins them
// with path.join (which produces \ on Windows) then normalizes back to /.
// This helper does the same for expected values so assertions match cross-platform.
const fwd = (...parts: string[]) => path.join(...parts).replaceAll("\\", "/")

// Skip reason: creating symlinks on Windows requires elevated privileges or
// Developer Mode; without them fs.symlink fails with EPERM. Probe once so the
// tests stay active wherever symlinks ARE permitted (Linux/macOS, and Windows
// with Developer Mode enabled).
const canSymlink = await (async () => {
  if (process.platform !== "win32") return true
  try {
    const probe = path.join(os.tmpdir(), `duoduo-symlink-probe-${process.pid}`)
    await fs.writeFile(probe, "probe")
    await fs.symlink(probe, `${probe}.link`, "file")
    await fs.rm(`${probe}.link`)
    await fs.rm(probe)
    return true
  } catch {
    return false
  }
})()

// Skip reason: the POSIX permission model (chmod/chown, mode bits) does not
// exist on Windows/NTFS — the bun shell cannot run `chmod` there.
const hasPosixPermissions = process.platform !== "win32"

import { disposeAllWithTimeout } from "../lib/dispose"

afterEach(async () => {
  await disposeAllWithTimeout()
})

async function bootstrap() {
  return tmpdir({
    git: true,
    init: async (dir) => {
      const unique = Math.random().toString(36).slice(2)
      const aContent = `A${unique}`
      const bContent = `B${unique}`
      await Filesystem.write(`${dir}/a.txt`, aContent)
      await Filesystem.write(`${dir}/b.txt`, bContent)
      await $`git add .`.cwd(dir).quiet()
      await $`git commit -m init`.cwd(dir).quiet()
      return {
        aContent,
        bContent,
      }
    },
  })
}

function run<A>(dir: string, body: (snapshot: Snapshot.Interface) => Effect.Effect<A>) {
  const { project, worktree } = testProjectInfo(dir, true)
  return Effect.runPromise(
    Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      return yield* body(snapshot)
    }).pipe(provideInstance(dir, project, worktree), Effect.provide(Snapshot.defaultLayer)),
  )
}

test("tracks deleted files correctly", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await $`rm ${tmp.path}/a.txt`.quiet()

      expect((await run(tmp.path, (snapshot) => snapshot.patch(before!))).files).toContain(fwd(tmp.path, "a.txt"))
    },
  })
})

test("revert should remove new files", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/new.txt`, "NEW")

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))

      await run(tmp.path, (snapshot) => snapshot.revert([patch]))

      expect(
        await fs
          .access(`${tmp.path}/new.txt`)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})

test("revert in subdirectory", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await $`mkdir -p ${tmp.path}/sub`.quiet()
      await Filesystem.write(`${tmp.path}/sub/file.txt`, "SUB")

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))

      await run(tmp.path, (snapshot) => snapshot.revert([patch]))

      expect(
        await fs
          .access(`${tmp.path}/sub/file.txt`)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
      // Note: revert currently only removes files, not directories
      // The empty subdirectory will remain
    },
  })
})

test("multiple file operations", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await $`rm ${tmp.path}/a.txt`.quiet()
      await Filesystem.write(`${tmp.path}/c.txt`, "C")
      await $`mkdir -p ${tmp.path}/dir`.quiet()
      await Filesystem.write(`${tmp.path}/dir/d.txt`, "D")
      await Filesystem.write(`${tmp.path}/b.txt`, "MODIFIED")

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))

      await run(tmp.path, (snapshot) => snapshot.revert([patch]))

      expect(await fs.readFile(`${tmp.path}/a.txt`, "utf-8")).toBe(tmp.extra.aContent)
      expect(
        await fs
          .access(`${tmp.path}/c.txt`)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
      // Note: revert currently only removes files, not directories
      // The empty directory will remain
      expect(await fs.readFile(`${tmp.path}/b.txt`, "utf-8")).toBe(tmp.extra.bContent)
    },
  })
})

test("empty directory handling", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await $`mkdir ${tmp.path}/empty`.quiet()

      expect((await run(tmp.path, (snapshot) => snapshot.patch(before!))).files.length).toBe(0)
    },
  })
})

test("binary file handling", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/image.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))
      expect(patch.files).toContain(fwd(tmp.path, "image.png"))

      await run(tmp.path, (snapshot) => snapshot.revert([patch]))
      expect(
        await fs
          .access(`${tmp.path}/image.png`)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})

test.skipIf(!canSymlink)("symlink handling", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await fs.symlink(`${tmp.path}/a.txt`, `${tmp.path}/link.txt`, "file")

      expect((await run(tmp.path, (snapshot) => snapshot.patch(before!))).files).toContain(fwd(tmp.path, "link.txt"))
    },
  })
})

test("file under size limit handling", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/large.txt`, "x".repeat(1024 * 1024))

      expect((await run(tmp.path, (snapshot) => snapshot.patch(before!))).files).toContain(fwd(tmp.path, "large.txt"))
    },
  })
})

test("large added files are skipped", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/huge.txt`, new Uint8Array(2 * 1024 * 1024 + 1))

      expect((await run(tmp.path, (snapshot) => snapshot.patch(before!))).files).toEqual([])
      expect(await run(tmp.path, (snapshot) => snapshot.diff(before!))).toBe("")
      expect(await run(tmp.path, (snapshot) => snapshot.track())).toBe(before)
    },
  })
})

test("nested directory revert", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await $`mkdir -p ${tmp.path}/level1/level2/level3`.quiet()
      await Filesystem.write(`${tmp.path}/level1/level2/level3/deep.txt`, "DEEP")

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))

      await run(tmp.path, (snapshot) => snapshot.revert([patch]))

      expect(
        await fs
          .access(`${tmp.path}/level1/level2/level3/deep.txt`)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})

test("special characters in filenames", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/file with spaces.txt`, "SPACES")
      await Filesystem.write(`${tmp.path}/file-with-dashes.txt`, "DASHES")
      await Filesystem.write(`${tmp.path}/file_with_underscores.txt`, "UNDERSCORES")

      const files = (await run(tmp.path, (snapshot) => snapshot.patch(before!))).files
      expect(files).toContain(fwd(tmp.path, "file with spaces.txt"))
      expect(files).toContain(fwd(tmp.path, "file-with-dashes.txt"))
      expect(files).toContain(fwd(tmp.path, "file_with_underscores.txt"))
    },
  })
})

test("revert with empty patches", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Should not crash with empty patches
      expect(run(tmp.path, (snapshot) => snapshot.revert([], true))).resolves.toBeUndefined()

      // Should not crash with patches that have empty file lists
      expect(run(tmp.path, (snapshot) => snapshot.revert([{ hash: "dummy", files: [] }], true))).resolves.toBeUndefined()
    },
  })
})

test("patch with invalid hash", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      // Create a change
      await Filesystem.write(`${tmp.path}/test.txt`, "TEST")

      // Try to patch with invalid hash - should handle gracefully
      const patch = await run(tmp.path, (snapshot) => snapshot.patch("invalid-hash-12345"))
      expect(patch.files).toEqual([])
      expect(patch.hash).toBe("invalid-hash-12345")
    },
  })
})

test("revert non-existent file", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      // Try to revert a file that doesn't exist in the snapshot
      // This should not crash
      expect(
        run(tmp.path, (snapshot) =>
          snapshot.revert([
            {
              hash: before!,
              files: [`${tmp.path}/nonexistent.txt`],
            },
          ]),
        ),
      ).resolves.toBeUndefined()
    },
  })
})

test("unicode filenames", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      const unicodeFiles = [
        { path: fwd(tmp.path, "文件.txt"), content: "chinese content" },
        { path: fwd(tmp.path, "🚀rocket.txt"), content: "emoji content" },
        { path: fwd(tmp.path, "café.txt"), content: "accented content" },
        { path: fwd(tmp.path, "файл.txt"), content: "cyrillic content" },
      ]

      for (const file of unicodeFiles) {
        await Filesystem.write(file.path, file.content)
      }

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))
      expect(patch.files.length).toBe(4)

      for (const file of unicodeFiles) {
        expect(patch.files).toContain(file.path)
      }

      await run(tmp.path, (snapshot) => snapshot.revert([patch]))

      for (const file of unicodeFiles) {
        expect(
          await fs
            .access(file.path)
            .then(() => true)
            .catch(() => false),
        ).toBe(false)
      }
    },
  })
})

test("unicode filenames modification and restore", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const chineseFile = fwd(tmp.path, "文件.txt")
      const cyrillicFile = fwd(tmp.path, "файл.txt")

      await Filesystem.write(chineseFile, "original chinese")
      await Filesystem.write(cyrillicFile, "original cyrillic")

      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(chineseFile, "modified chinese")
      await Filesystem.write(cyrillicFile, "modified cyrillic")

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))
      expect(patch.files).toContain(chineseFile)
      expect(patch.files).toContain(cyrillicFile)

      await run(tmp.path, (snapshot) => snapshot.revert([patch]))

      expect(await fs.readFile(chineseFile, "utf-8")).toBe("original chinese")
      expect(await fs.readFile(cyrillicFile, "utf-8")).toBe("original cyrillic")
    },
  })
})

test("unicode filenames in subdirectories", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await $`mkdir -p "${tmp.path}/目录/подкаталог"`.quiet()
      const deepFile = fwd(tmp.path, "目录", "подкаталог", "文件.txt")
      await Filesystem.write(deepFile, "deep unicode content")

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))
      expect(patch.files).toContain(deepFile)

      await run(tmp.path, (snapshot) => snapshot.revert([patch]))
      expect(
        await fs
          .access(deepFile)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})

test("very long filenames", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      const longName = "a".repeat(200) + ".txt"
      const longFile = fwd(tmp.path, longName)

      await Filesystem.write(longFile, "long filename content")

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))
      expect(patch.files).toContain(longFile)

      await run(tmp.path, (snapshot) => snapshot.revert([patch]))
      expect(
        await fs
          .access(longFile)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})

test("hidden files", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/.hidden`, "hidden content")
      await Filesystem.write(`${tmp.path}/.gitignore`, "*.log")
      await Filesystem.write(`${tmp.path}/.config`, "config content")

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))
      expect(patch.files).toContain(fwd(tmp.path, ".hidden"))
      expect(patch.files).toContain(fwd(tmp.path, ".gitignore"))
      expect(patch.files).toContain(fwd(tmp.path, ".config"))
    },
  })
})

test.skipIf(!canSymlink)("nested symlinks", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await $`mkdir -p ${tmp.path}/sub/dir`.quiet()
      await Filesystem.write(`${tmp.path}/sub/dir/target.txt`, "target content")
      await fs.symlink(`${tmp.path}/sub/dir/target.txt`, `${tmp.path}/sub/dir/link.txt`, "file")
      await fs.symlink(`${tmp.path}/sub`, `${tmp.path}/sub-link`, "dir")

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))
      expect(patch.files).toContain(fwd(tmp.path, "sub", "dir", "link.txt"))
      expect(patch.files).toContain(fwd(tmp.path, "sub-link"))
    },
  })
})

test.skipIf(!hasPosixPermissions)("file permissions and ownership changes", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      // Change permissions multiple times
      await $`chmod 600 ${tmp.path}/a.txt`.quiet()
      await $`chmod 755 ${tmp.path}/a.txt`.quiet()
      await $`chmod 644 ${tmp.path}/a.txt`.quiet()

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))
      // Note: git doesn't track permission changes on existing files by default
      // Only tracks executable bit when files are first added
      expect(patch.files.length).toBe(0)
    },
  })
})

test("circular symlinks", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      // Create circular symlink
      await fs.symlink(`${tmp.path}/circular`, `${tmp.path}/circular`, "dir").catch(() => {})

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))
      expect(patch.files.length).toBeGreaterThanOrEqual(0) // Should not crash
    },
  })
})

test("source project gitignore is respected - ignored files are not snapshotted", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      // Create gitignore BEFORE any tracking
      await Filesystem.write(`${dir}/.gitignore`, "*.ignored\nbuild/\nnode_modules/\n")
      await Filesystem.write(`${dir}/tracked.txt`, "tracked content")
      await Filesystem.write(`${dir}/ignored.ignored`, "ignored content")
      await $`mkdir -p ${dir}/build`.quiet()
      await Filesystem.write(`${dir}/build/output.js`, "build output")
      await Filesystem.write(`${dir}/normal.js`, "normal js")
      await $`git add .`.cwd(dir).quiet()
      await $`git commit -m init`.cwd(dir).quiet()
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      // Modify tracked files and create new ones - some ignored, some not
      await Filesystem.write(`${tmp.path}/tracked.txt`, "modified tracked")
      await Filesystem.write(`${tmp.path}/new.ignored`, "new ignored")
      await Filesystem.write(`${tmp.path}/new-tracked.txt`, "new tracked")
      await Filesystem.write(`${tmp.path}/build/new-build.js`, "new build file")

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))

      // Modified and new tracked files should be in snapshot
      expect(patch.files).toContain(fwd(tmp.path, "new-tracked.txt"))
      expect(patch.files).toContain(fwd(tmp.path, "tracked.txt"))

      // Ignored files should NOT be in snapshot
      expect(patch.files).not.toContain(fwd(tmp.path, "new.ignored"))
      expect(patch.files).not.toContain(fwd(tmp.path, "ignored.ignored"))
      expect(patch.files).not.toContain(fwd(tmp.path, "build/output.js"))
      expect(patch.files).not.toContain(fwd(tmp.path, "build/new-build.js"))
    },
  })
})

test("gitignore changes", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/.gitignore`, "*.ignored")
      await Filesystem.write(`${tmp.path}/test.ignored`, "ignored content")
      await Filesystem.write(`${tmp.path}/normal.txt`, "normal content")

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))

      // Should track gitignore itself
      expect(patch.files).toContain(fwd(tmp.path, ".gitignore"))
      // Should track normal files
      expect(patch.files).toContain(fwd(tmp.path, "normal.txt"))
      // Should not track ignored files (git won't see them)
      expect(patch.files).not.toContain(fwd(tmp.path, "test.ignored"))
    },
  })
})

test("files tracked in snapshot but now gitignored are filtered out", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // First, create a file and snapshot it
      await Filesystem.write(`${tmp.path}/later-ignored.txt`, "initial content")
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      // Modify the file (so it appears in diff-files)
      await Filesystem.write(`${tmp.path}/later-ignored.txt`, "modified content")

      // Now add gitignore that would exclude this file
      await Filesystem.write(`${tmp.path}/.gitignore`, "later-ignored.txt\n")

      // Also create another tracked file
      await Filesystem.write(`${tmp.path}/still-tracked.txt`, "new tracked file")

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))

      // The file that is now gitignored should NOT appear, even though it was
      // previously tracked and modified
      expect(patch.files).not.toContain(fwd(tmp.path, "later-ignored.txt"))

      // The gitignore file itself should appear
      expect(patch.files).toContain(fwd(tmp.path, ".gitignore"))

      // Other tracked files should appear
      expect(patch.files).toContain(fwd(tmp.path, "still-tracked.txt"))
    },
  })
})

test("gitignore updated between track calls filters from diff", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // a.txt is already committed from bootstrap - track it in snapshot
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      // Modify a.txt (so it appears in diff-files)
      await Filesystem.write(`${tmp.path}/a.txt`, "modified content")

      // Now add gitignore that would exclude a.txt
      await Filesystem.write(`${tmp.path}/.gitignore`, "a.txt\n")

      // Also modify b.txt which is not gitignored
      await Filesystem.write(`${tmp.path}/b.txt`, "also modified")

      // Second track - should not include a.txt even though it changed
      const after = await run(tmp.path, (snapshot) => snapshot.track())
      expect(after).toBeTruthy()

      // Verify a.txt is NOT in the diff between snapshots
      const diffs = await run(tmp.path, (snapshot) => snapshot.diffFull(before!, after!))
      expect(diffs.some((x) => x.file === "a.txt")).toBe(false)

      // But .gitignore should be in the diff
      expect(diffs.some((x) => x.file === ".gitignore")).toBe(true)

      // b.txt should be in the diff (not gitignored)
      expect(diffs.some((x) => x.file === "b.txt")).toBe(true)
    },
  })
})

test("git info exclude changes", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      const file = `${tmp.path}/.git/info/exclude`
      const text = await Bun.file(file).text()
      await Bun.write(file, `${text.trimEnd()}\nignored.txt\n`)
      await Bun.write(`${tmp.path}/ignored.txt`, "ignored content")
      await Bun.write(`${tmp.path}/normal.txt`, "normal content")

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))
      expect(patch.files).toContain(fwd(tmp.path, "normal.txt"))
      expect(patch.files).not.toContain(fwd(tmp.path, "ignored.txt"))

      const after = await run(tmp.path, (snapshot) => snapshot.track())
      const diffs = await run(tmp.path, (snapshot) => snapshot.diffFull(before!, after!))
      expect(diffs.some((x) => x.file === "normal.txt")).toBe(true)
      expect(diffs.some((x) => x.file === "ignored.txt")).toBe(false)
    },
  })
})

test("git info exclude keeps global excludes", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const global = `${tmp.path}/global.ignore`
      const config = `${tmp.path}/global.gitconfig`
      await Bun.write(global, "global.tmp\n")
      await Bun.write(config, `[core]\n\texcludesFile = ${global.replaceAll("\\", "/")}\n`)

      const prev = process.env.GIT_CONFIG_GLOBAL
      process.env.GIT_CONFIG_GLOBAL = config
      try {
        const before = await run(tmp.path, (snapshot) => snapshot.track())
        expect(before).toBeTruthy()

        const file = `${tmp.path}/.git/info/exclude`
        const text = await Bun.file(file).text()
        await Bun.write(file, `${text.trimEnd()}\ninfo.tmp\n`)

        await Bun.write(`${tmp.path}/global.tmp`, "global content")
        await Bun.write(`${tmp.path}/info.tmp`, "info content")
        await Bun.write(`${tmp.path}/normal.txt`, "normal content")

        const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))
        expect(patch.files).toContain(fwd(tmp.path, "normal.txt"))
        expect(patch.files).not.toContain(fwd(tmp.path, "global.tmp"))
        expect(patch.files).not.toContain(fwd(tmp.path, "info.tmp"))
      } finally {
        if (prev) process.env.GIT_CONFIG_GLOBAL = prev
        else delete process.env.GIT_CONFIG_GLOBAL
      }
    },
  })
})

test("concurrent file operations during patch", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      // Start creating files
      const createPromise = (async () => {
        for (let i = 0; i < 10; i++) {
          await Filesystem.write(`${tmp.path}/concurrent${i}.txt`, `concurrent${i}`)
          // Small delay to simulate concurrent operations
          await new Promise((resolve) => setTimeout(resolve, 1))
        }
      })()

      // Get patch while files are being created
      const patchPromise = run(tmp.path, (snapshot) => snapshot.patch(before!))

      await createPromise
      const patch = await patchPromise

      // Should capture some or all of the concurrent files
      expect(patch.files.length).toBeGreaterThanOrEqual(0)
    },
  })
})

test("snapshot state isolation between projects", async () => {
  // Test that different projects don't interfere with each other
  await using tmp1 = await bootstrap()
  await using tmp2 = await bootstrap()

  await Instance.provide({
    directory: tmp1.path,
    fn: async () => {
      const before1 = await run(tmp1.path, (snapshot) => snapshot.track())
      await Filesystem.write(`${tmp1.path}/project1.txt`, "project1 content")
      const patch1 = await run(tmp1.path, (snapshot) => snapshot.patch(before1!))
      expect(patch1.files).toContain(fwd(tmp1.path, "project1.txt"))
    },
  })

  await Instance.provide({
    directory: tmp2.path,
    fn: async () => {
      const before2 = await run(tmp2.path, (snapshot) => snapshot.track())
      await Filesystem.write(`${tmp2.path}/project2.txt`, "project2 content")
      const patch2 = await run(tmp2.path, (snapshot) => snapshot.patch(before2!))
      expect(patch2.files).toContain(fwd(tmp2.path, "project2.txt"))

      // Ensure project1 files don't appear in project2
      expect(patch2.files).not.toContain(fwd(tmp1?.path ?? "", "project1.txt"))
    },
  })
})

test("patch detects changes in secondary worktree", async () => {
  await using tmp = await bootstrap()
  const worktreePath = `${tmp.path}-worktree`
  await $`git worktree add ${worktreePath} HEAD`.cwd(tmp.path).quiet()

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await run(tmp.path, (snapshot) => snapshot.track())).toBeTruthy()
      },
    })

    await Instance.provide({
      directory: worktreePath,
      fn: async () => {
        const before = await run(worktreePath, (snapshot) => snapshot.track())
        expect(before).toBeTruthy()

        const worktreeFile = fwd(worktreePath, "worktree.txt")
        await Filesystem.write(worktreeFile, "worktree content")

        const patch = await run(worktreePath, (snapshot) => snapshot.patch(before!))
        expect(patch.files).toContain(worktreeFile)
      },
    })
  } finally {
    await $`git worktree remove --force ${worktreePath}`.cwd(tmp.path).quiet().nothrow()
    await $`rm -rf ${worktreePath}`.quiet()
  }
})

test("revert only removes files in invoking worktree", async () => {
  await using tmp = await bootstrap()
  const worktreePath = `${tmp.path}-worktree`
  await $`git worktree add ${worktreePath} HEAD`.cwd(tmp.path).quiet()

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await run(tmp.path, (snapshot) => snapshot.track())).toBeTruthy()
      },
    })
    const primaryFile = `${tmp.path}/worktree.txt`
    await Filesystem.write(primaryFile, "primary content")

    await Instance.provide({
      directory: worktreePath,
      fn: async () => {
        const before = await run(worktreePath, (snapshot) => snapshot.track())
        expect(before).toBeTruthy()

        const worktreeFile = fwd(worktreePath, "worktree.txt")
        await Filesystem.write(worktreeFile, "worktree content")

        const patch = await run(worktreePath, (snapshot) => snapshot.patch(before!))
        await run(worktreePath, (snapshot) => snapshot.revert([patch]))

        expect(
          await fs
            .access(worktreeFile)
            .then(() => true)
            .catch(() => false),
        ).toBe(false)
      },
    })

    expect(await fs.readFile(primaryFile, "utf-8")).toBe("primary content")
  } finally {
    await $`git worktree remove --force ${worktreePath}`.cwd(tmp.path).quiet().nothrow()
    await $`rm -rf ${worktreePath}`.quiet()
    await $`rm -f ${tmp.path}/worktree.txt`.quiet()
  }
})

test("diff reports worktree-only/shared edits and ignores primary-only", async () => {
  await using tmp = await bootstrap()
  const worktreePath = `${tmp.path}-worktree`
  await $`git worktree add ${worktreePath} HEAD`.cwd(tmp.path).quiet()

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await run(tmp.path, (snapshot) => snapshot.track())).toBeTruthy()
      },
    })

    await Instance.provide({
      directory: worktreePath,
      fn: async () => {
        const before = await run(worktreePath, (snapshot) => snapshot.track())
        expect(before).toBeTruthy()

        await Filesystem.write(`${worktreePath}/worktree-only.txt`, "worktree diff content")
        await Filesystem.write(`${worktreePath}/shared.txt`, "worktree edit")
        await Filesystem.write(`${tmp.path}/shared.txt`, "primary edit")
        await Filesystem.write(`${tmp.path}/primary-only.txt`, "primary change")

        const diff = await run(worktreePath, (snapshot) => snapshot.diff(before!))
        expect(diff).toContain("worktree-only.txt")
        expect(diff).toContain("shared.txt")
        expect(diff).not.toContain("primary-only.txt")
      },
    })
  } finally {
    await $`git worktree remove --force ${worktreePath}`.cwd(tmp.path).quiet().nothrow()
    await $`rm -rf ${worktreePath}`.quiet()
    await $`rm -f ${tmp.path}/shared.txt`.quiet()
    await $`rm -f ${tmp.path}/primary-only.txt`.quiet()
  }
})

test("track with no changes returns same hash", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const hash1 = await run(tmp.path, (snapshot) => snapshot.track())
      expect(hash1).toBeTruthy()

      // Track again with no changes
      const hash2 = await run(tmp.path, (snapshot) => snapshot.track())
      expect(hash2).toBe(hash1)

      // Track again
      const hash3 = await run(tmp.path, (snapshot) => snapshot.track())
      expect(hash3).toBe(hash1)
    },
  })
})

test("diff function with various changes", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      // Make various changes
      await $`rm ${tmp.path}/a.txt`.quiet()
      await Filesystem.write(`${tmp.path}/new.txt`, "new content")
      await Filesystem.write(`${tmp.path}/b.txt`, "modified content")

      const diff = await run(tmp.path, (snapshot) => snapshot.diff(before!))
      expect(diff).toContain("a.txt")
      expect(diff).toContain("b.txt")
      expect(diff).toContain("new.txt")
    },
  })
})

test("restore function", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      // Make changes
      await $`rm ${tmp.path}/a.txt`.quiet()
      await Filesystem.write(`${tmp.path}/new.txt`, "new content")
      await Filesystem.write(`${tmp.path}/b.txt`, "modified")

      // Restore to original state
      await run(tmp.path, (snapshot) => snapshot.restore(before!, true))

      expect(
        await fs
          .access(`${tmp.path}/a.txt`)
          .then(() => true)
          .catch(() => false),
      ).toBe(true)
      expect(await fs.readFile(`${tmp.path}/a.txt`, "utf-8")).toBe(tmp.extra.aContent)
      // E1: files created AFTER the snapshot are removed by a complete rollback.
      expect(
        await fs
          .access(`${tmp.path}/new.txt`)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
      expect(await fs.readFile(`${tmp.path}/b.txt`, "utf-8")).toBe(tmp.extra.bContent)
    },
  })
})

test("revert should not delete files that existed but were deleted in snapshot", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const snapshot1 = await run(tmp.path, (snapshot) => snapshot.track())
      expect(snapshot1).toBeTruthy()

      await $`rm ${tmp.path}/a.txt`.quiet()

      const snapshot2 = await run(tmp.path, (snapshot) => snapshot.track())
      expect(snapshot2).toBeTruthy()

      await Filesystem.write(`${tmp.path}/a.txt`, "recreated content")

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(snapshot2!))
      expect(patch.files).toContain(fwd(tmp.path, "a.txt"))

      await run(tmp.path, (snapshot) => snapshot.revert([patch]))

      expect(
        await fs
          .access(`${tmp.path}/a.txt`)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})

test("revert preserves file that existed in snapshot when deleted then recreated", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Filesystem.write(`${tmp.path}/existing.txt`, "original content")

      const hash = await run(tmp.path, (snapshot) => snapshot.track())
      expect(hash).toBeTruthy()

      await $`rm ${tmp.path}/existing.txt`.quiet()
      await Filesystem.write(`${tmp.path}/existing.txt`, "recreated")
      await Filesystem.write(`${tmp.path}/newfile.txt`, "new")

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(hash!))
      expect(patch.files).toContain(fwd(tmp.path, "existing.txt"))
      expect(patch.files).toContain(fwd(tmp.path, "newfile.txt"))

      await run(tmp.path, (snapshot) => snapshot.revert([patch]))

      expect(
        await fs
          .access(`${tmp.path}/newfile.txt`)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
      expect(
        await fs
          .access(`${tmp.path}/existing.txt`)
          .then(() => true)
          .catch(() => false),
      ).toBe(true)
      expect(await fs.readFile(`${tmp.path}/existing.txt`, "utf-8")).toBe("original content")
    },
  })
})

test("diffFull sets status based on git change type", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Filesystem.write(`${tmp.path}/grow.txt`, "one\n")
      await Filesystem.write(`${tmp.path}/trim.txt`, "line1\nline2\n")
      await Filesystem.write(`${tmp.path}/delete.txt`, "gone")

      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/grow.txt`, "one\ntwo\n")
      await Filesystem.write(`${tmp.path}/trim.txt`, "line1\n")
      await $`rm ${tmp.path}/delete.txt`.quiet()
      await Filesystem.write(`${tmp.path}/added.txt`, "new")

      const after = await run(tmp.path, (snapshot) => snapshot.track())
      expect(after).toBeTruthy()

      const diffs = await run(tmp.path, (snapshot) => snapshot.diffFull(before!, after!))
      expect(diffs.length).toBe(4)

      const added = diffs.find((d) => d.file === "added.txt")
      expect(added).toBeDefined()
      expect(added!.status).toBe("added")

      const deleted = diffs.find((d) => d.file === "delete.txt")
      expect(deleted).toBeDefined()
      expect(deleted!.status).toBe("deleted")

      const grow = diffs.find((d) => d.file === "grow.txt")
      expect(grow).toBeDefined()
      expect(grow!.status).toBe("modified")
      expect(grow!.additions).toBeGreaterThan(0)
      expect(grow!.deletions).toBe(0)

      const trim = diffs.find((d) => d.file === "trim.txt")
      expect(trim).toBeDefined()
      expect(trim!.status).toBe("modified")
      expect(trim!.additions).toBe(0)
      expect(trim!.deletions).toBeGreaterThan(0)
    },
  })
})

test("diffFull with new file additions", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/new.txt`, "new content")

      const after = await run(tmp.path, (snapshot) => snapshot.track())
      expect(after).toBeTruthy()

      const diffs = await run(tmp.path, (snapshot) => snapshot.diffFull(before!, after!))
      expect(diffs.length).toBe(1)

      const newFileDiff = diffs[0]
      expect(newFileDiff.file).toBe("new.txt")
      expect(newFileDiff.patch).toContain("+new content")
      expect(newFileDiff.additions).toBe(1)
      expect(newFileDiff.deletions).toBe(0)
    },
  })
})

test("diffFull with a large interleaved mixed diff", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ids = Array.from({ length: 60 }, (_, i) => i.toString().padStart(3, "0"))
      const mod = ids.map((id) => fwd(tmp.path, "mix", `${id}-mod.txt`))
      const del = ids.map((id) => fwd(tmp.path, "mix", `${id}-del.txt`))
      const add = ids.map((id) => fwd(tmp.path, "mix", `${id}-add.txt`))
      const bin = ids.map((id) => fwd(tmp.path, "mix", `${id}-bin.bin`))

      await $`mkdir -p ${tmp.path}/mix`.quiet()
      await Promise.all([
        ...mod.map((file, i) => Filesystem.write(file, `before-${ids[i]}-é\n🙂\nline`)),
        ...del.map((file, i) => Filesystem.write(file, `gone-${ids[i]}\n你好`)),
        ...bin.map((file, i) => Filesystem.write(file, new Uint8Array([0, i, 255, i % 251]))),
      ])

      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Promise.all([
        ...mod.map((file, i) => Filesystem.write(file, `after-${ids[i]}-é\n🚀\nline`)),
        ...add.map((file, i) => Filesystem.write(file, `new-${ids[i]}\nこんにちは`)),
        ...bin.map((file, i) => Filesystem.write(file, new Uint8Array([9, i, 8, i % 251]))),
        ...del.map((file) => fs.rm(file)),
      ])

      const after = await run(tmp.path, (snapshot) => snapshot.track())
      expect(after).toBeTruthy()

      const diffs = await run(tmp.path, (snapshot) => snapshot.diffFull(before!, after!))
      expect(diffs).toHaveLength(ids.length * 4)

      const map = new Map(diffs.map((item) => [item.file, item]))
      for (let i = 0; i < ids.length; i++) {
        const m = map.get(fwd("mix", `${ids[i]}-mod.txt`))
        expect(m).toBeDefined()
        expect(m!.patch).toContain(`-before-${ids[i]}-é`)
        expect(m!.patch).toContain(`+after-${ids[i]}-é`)
        expect(m!.status).toBe("modified")

        const d = map.get(fwd("mix", `${ids[i]}-del.txt`))
        expect(d).toBeDefined()
        expect(d!.patch).toContain(`-gone-${ids[i]}`)
        expect(d!.status).toBe("deleted")

        const a = map.get(fwd("mix", `${ids[i]}-add.txt`))
        expect(a).toBeDefined()
        expect(a!.patch).toContain(`+new-${ids[i]}`)
        expect(a!.status).toBe("added")

        const b = map.get(fwd("mix", `${ids[i]}-bin.bin`))
        expect(b).toBeDefined()
        expect(b!.patch).toBe("")
        expect(b!.additions).toBe(0)
        expect(b!.deletions).toBe(0)
        expect(b!.status).toBe("modified")
      }
    },
  })
})

test("diffFull preserves git diff order across batch boundaries", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ids = Array.from({ length: 140 }, (_, i) => i.toString().padStart(3, "0"))

      await $`mkdir -p ${tmp.path}/order`.quiet()
      await Promise.all(ids.map((id) => Filesystem.write(`${tmp.path}/order/${id}.txt`, `before-${id}`)))

      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Promise.all(ids.map((id) => Filesystem.write(`${tmp.path}/order/${id}.txt`, `after-${id}`)))

      const after = await run(tmp.path, (snapshot) => snapshot.track())
      expect(after).toBeTruthy()

      const expected = ids.map((id) => `order/${id}.txt`)

      const diffs = await run(tmp.path, (snapshot) => snapshot.diffFull(before!, after!))
      expect(diffs.map((item) => item.file)).toEqual(expected)
    },
  })
})

test("diffFull with file modifications", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/b.txt`, "modified content")

      const after = await run(tmp.path, (snapshot) => snapshot.track())
      expect(after).toBeTruthy()

      const diffs = await run(tmp.path, (snapshot) => snapshot.diffFull(before!, after!))
      expect(diffs.length).toBe(1)

      const modifiedFileDiff = diffs[0]
      expect(modifiedFileDiff.file).toBe("b.txt")
      expect(modifiedFileDiff.patch).toContain(`-${tmp.extra.bContent}`)
      expect(modifiedFileDiff.patch).toContain("+modified content")
      expect(modifiedFileDiff.additions).toBeGreaterThan(0)
      expect(modifiedFileDiff.deletions).toBeGreaterThan(0)
    },
  })
})

test("diffFull with file deletions", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await $`rm ${tmp.path}/a.txt`.quiet()

      const after = await run(tmp.path, (snapshot) => snapshot.track())
      expect(after).toBeTruthy()

      const diffs = await run(tmp.path, (snapshot) => snapshot.diffFull(before!, after!))
      expect(diffs.length).toBe(1)

      const removedFileDiff = diffs[0]
      expect(removedFileDiff.file).toBe("a.txt")
      expect(removedFileDiff.patch).toContain(`-${tmp.extra.aContent}`)
      expect(removedFileDiff.additions).toBe(0)
      expect(removedFileDiff.deletions).toBe(1)
    },
  })
})

test("diffFull with multiple line additions", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/multi.txt`, "line1\nline2\nline3")

      const after = await run(tmp.path, (snapshot) => snapshot.track())
      expect(after).toBeTruthy()

      const diffs = await run(tmp.path, (snapshot) => snapshot.diffFull(before!, after!))
      expect(diffs.length).toBe(1)

      const multiDiff = diffs[0]
      expect(multiDiff.file).toBe("multi.txt")
      expect(multiDiff.patch).toContain("+line1")
      expect(multiDiff.patch).toContain("+line3")
      expect(multiDiff.additions).toBe(3)
      expect(multiDiff.deletions).toBe(0)
    },
  })
})

test("diffFull with addition and deletion", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/added.txt`, "added content")
      await $`rm ${tmp.path}/a.txt`.quiet()

      const after = await run(tmp.path, (snapshot) => snapshot.track())
      expect(after).toBeTruthy()

      const diffs = await run(tmp.path, (snapshot) => snapshot.diffFull(before!, after!))
      expect(diffs.length).toBe(2)

      const addedFileDiff = diffs.find((d) => d.file === "added.txt")
      expect(addedFileDiff).toBeDefined()
      expect(addedFileDiff!.patch).toContain("+added content")
      expect(addedFileDiff!.additions).toBe(1)
      expect(addedFileDiff!.deletions).toBe(0)

      const removedFileDiff = diffs.find((d) => d.file === "a.txt")
      expect(removedFileDiff).toBeDefined()
      expect(removedFileDiff!.patch).toContain(`-${tmp.extra.aContent}`)
      expect(removedFileDiff!.additions).toBe(0)
      expect(removedFileDiff!.deletions).toBe(1)
    },
  })
})

test("diffFull with multiple additions and deletions", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/multi1.txt`, "line1\nline2\nline3")
      await Filesystem.write(`${tmp.path}/multi2.txt`, "single line")
      await $`rm ${tmp.path}/a.txt`.quiet()
      await $`rm ${tmp.path}/b.txt`.quiet()

      const after = await run(tmp.path, (snapshot) => snapshot.track())
      expect(after).toBeTruthy()

      const diffs = await run(tmp.path, (snapshot) => snapshot.diffFull(before!, after!))
      expect(diffs.length).toBe(4)

      const multi1Diff = diffs.find((d) => d.file === "multi1.txt")
      expect(multi1Diff).toBeDefined()
      expect(multi1Diff!.additions).toBe(3)
      expect(multi1Diff!.deletions).toBe(0)

      const multi2Diff = diffs.find((d) => d.file === "multi2.txt")
      expect(multi2Diff).toBeDefined()
      expect(multi2Diff!.additions).toBe(1)
      expect(multi2Diff!.deletions).toBe(0)

      const removedADiff = diffs.find((d) => d.file === "a.txt")
      expect(removedADiff).toBeDefined()
      expect(removedADiff!.additions).toBe(0)
      expect(removedADiff!.deletions).toBe(1)

      const removedBDiff = diffs.find((d) => d.file === "b.txt")
      expect(removedBDiff).toBeDefined()
      expect(removedBDiff!.additions).toBe(0)
      expect(removedBDiff!.deletions).toBe(1)
    },
  })
})

test("diffFull with no changes", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      const after = await run(tmp.path, (snapshot) => snapshot.track())
      expect(after).toBeTruthy()

      const diffs = await run(tmp.path, (snapshot) => snapshot.diffFull(before!, after!))
      expect(diffs.length).toBe(0)
    },
  })
})

test("diffFull with binary file changes", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/binary.bin`, new Uint8Array([0x00, 0x01, 0x02, 0x03]))

      const after = await run(tmp.path, (snapshot) => snapshot.track())
      expect(after).toBeTruthy()

      const diffs = await run(tmp.path, (snapshot) => snapshot.diffFull(before!, after!))
      expect(diffs.length).toBe(1)

      const binaryDiff = diffs[0]
      expect(binaryDiff.file).toBe("binary.bin")
      expect(binaryDiff.patch).toBe("")
    },
  })
})

test("diffFull with whitespace changes", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Filesystem.write(`${tmp.path}/whitespace.txt`, "line1\nline2")
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/whitespace.txt`, "line1\n\nline2\n")

      const after = await run(tmp.path, (snapshot) => snapshot.track())
      expect(after).toBeTruthy()

      const diffs = await run(tmp.path, (snapshot) => snapshot.diffFull(before!, after!))
      expect(diffs.length).toBe(1)

      const whitespaceDiff = diffs[0]
      expect(whitespaceDiff.file).toBe("whitespace.txt")
      expect(whitespaceDiff.additions).toBeGreaterThan(0)
    },
  })
})

test("revert with overlapping files across patches uses first patch hash", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Write initial content and snapshot
      await Filesystem.write(`${tmp.path}/shared.txt`, "v1")
      const snap1 = await run(tmp.path, (snapshot) => snapshot.track())
      expect(snap1).toBeTruthy()

      // Modify and snapshot again
      await Filesystem.write(`${tmp.path}/shared.txt`, "v2")
      const snap2 = await run(tmp.path, (snapshot) => snapshot.track())
      expect(snap2).toBeTruthy()

      // Modify once more so both patches include shared.txt
      await Filesystem.write(`${tmp.path}/shared.txt`, "v3")

      const patch1 = await run(tmp.path, (snapshot) => snapshot.patch(snap1!))
      const patch2 = await run(tmp.path, (snapshot) => snapshot.patch(snap2!))

      // Both patches should include shared.txt
      expect(patch1.files).toContain(fwd(tmp.path, "shared.txt"))
      expect(patch2.files).toContain(fwd(tmp.path, "shared.txt"))

      // Revert with patch1 first — should use snap1's hash (restoring "v1")
      await run(tmp.path, (snapshot) => snapshot.revert([patch1, patch2]))

      const content = await fs.readFile(`${tmp.path}/shared.txt`, "utf-8")
      expect(content).toBe("v1")
    },
  })
})

test("revert preserves patch order when the same hash appears again", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await $`mkdir -p ${tmp.path}/foo`.quiet()
      await Filesystem.write(`${tmp.path}/foo/bar`, "v1")
      await Filesystem.write(`${tmp.path}/a.txt`, "v1")

      const snap1 = await run(tmp.path, (snapshot) => snapshot.track())
      expect(snap1).toBeTruthy()

      await $`rm -rf ${tmp.path}/foo`.quiet()
      await Filesystem.write(`${tmp.path}/foo`, "v2")
      await Filesystem.write(`${tmp.path}/a.txt`, "v2")

      const snap2 = await run(tmp.path, (snapshot) => snapshot.track())
      expect(snap2).toBeTruthy()

      await $`rm -rf ${tmp.path}/foo`.quiet()
      await Filesystem.write(`${tmp.path}/a.txt`, "v3")

      await run(tmp.path, (snapshot) =>
        snapshot.revert(
          [
            { hash: snap1!, files: [fwd(tmp.path, "a.txt")] },
            { hash: snap2!, files: [fwd(tmp.path, "foo")] },
            { hash: snap1!, files: [fwd(tmp.path, "foo", "bar")] },
          ],
          true,
        ),
      )

      expect(await fs.readFile(`${tmp.path}/a.txt`, "utf-8")).toBe("v1")
      expect((await fs.stat(`${tmp.path}/foo`)).isDirectory()).toBe(true)
      expect(await fs.readFile(`${tmp.path}/foo/bar`, "utf-8")).toBe("v1")
    },
  })
})

test("revert handles large mixed batches across chunk boundaries", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const base = Array.from({ length: 140 }, (_, i) => fwd(tmp.path, "batch", `${i}.txt`))
      const fresh = Array.from({ length: 140 }, (_, i) => fwd(tmp.path, "fresh", `${i}.txt`))

      await $`mkdir -p ${tmp.path}/batch ${tmp.path}/fresh`.quiet()
      await Promise.all(base.map((file, i) => Filesystem.write(file, `base-${i}`)))

      const snap = await run(tmp.path, (snapshot) => snapshot.track())
      expect(snap).toBeTruthy()

      await Promise.all(base.map((file, i) => Filesystem.write(file, `next-${i}`)))
      await Promise.all(fresh.map((file, i) => Filesystem.write(file, `fresh-${i}`)))

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(snap!))
      expect(patch.files.length).toBe(base.length + fresh.length)

      await run(tmp.path, (snapshot) => snapshot.revert([patch]))

      await Promise.all(
        base.map(async (file, i) => {
          expect(await fs.readFile(file, "utf-8")).toBe(`base-${i}`)
        }),
      )

      await Promise.all(
        fresh.map(async (file) => {
          expect(
            await fs
              .access(file)
              .then(() => true)
              .catch(() => false),
          ).toBe(false)
        }),
      )
    },
  })
})

// ============================================================================
// dirty flag + safety net (P2-2)
// ============================================================================

test("track returns same hash when called twice without changes (dirty=false fast path)", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const first = await run(tmp.path, (snapshot) => snapshot.track())
      expect(first).toBeTruthy()
      // No file changes between calls. Dirty flag should be false on second call.
      // The safety net (git diff-files + ls-files --others) should detect no drift.
      const second = await run(tmp.path, (snapshot) => snapshot.track())
      expect(second).toBe(first)
    },
  })
})

test("track captures changes when markDirty is called explicitly", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/a.txt`, "MODIFIED")

      const after = await run(tmp.path, (snapshot) =>
        Effect.gen(function* () {
          yield* snapshot.markDirty()
          return yield* snapshot.track()
        }),
      )
      expect(after).toBeTruthy()
      expect(after).not.toBe(before)
    },
  })
})

test("safety net catches unstaged modifications even when markDirty was NOT called", async () => {
  // This is the critical zero-risk test: simulates the case where a file change
  // bypasses our dirty flag (e.g., external editor, bash side-effect with no FileWatcher event).
  // The safety net (git diff-files --quiet) must detect it and force-add.
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      // Modify a tracked file WITHOUT calling markDirty
      await Filesystem.write(`${tmp.path}/a.txt`, "SAFETY_NET_TEST_MODIFIED")

      // Even without markDirty, track() must capture this via diff-files safety net
      const after = await run(tmp.path, (snapshot) => snapshot.track())
      expect(after).toBeTruthy()
      expect(after).not.toBe(before)

      // patch() against the old hash must include the modified file
      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))
      expect(patch.files).toContain(fwd(tmp.path, "a.txt"))
    },
  })
})

test("safety net catches untracked files even when markDirty was NOT called", async () => {
  // diff-files only sees tracked-file modifications. The second safety check
  // (ls-files --others --exclude-standard) catches new files.
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      // Add a new file WITHOUT calling markDirty
      await Filesystem.write(`${tmp.path}/new-untracked.txt`, "UNTRACKED")

      const after = await run(tmp.path, (snapshot) => snapshot.track())
      expect(after).toBeTruthy()
      expect(after).not.toBe(before)
    },
  })
})

test("safety net catches deletions even when markDirty was NOT called", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      // Delete a tracked file WITHOUT calling markDirty
      await $`rm ${tmp.path}/a.txt`.quiet()

      const after = await run(tmp.path, (snapshot) => snapshot.track())
      expect(after).toBeTruthy()
      expect(after).not.toBe(before)

      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))
      expect(patch.files).toContain(fwd(tmp.path, "a.txt"))
    },
  })
})

test("revert still works correctly after dirty flag optimization", async () => {
  // Ensures the new track() logic doesn't break the revert workflow,
  // which is the most safety-critical use case (data integrity for undo).
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const initial = await run(tmp.path, (snapshot) => snapshot.track())
      expect(initial).toBeTruthy()

      // Make a change WITHOUT calling markDirty (simulates missed event)
      await Filesystem.write(`${tmp.path}/a.txt`, "DIRTY_TEST")

      // Safety net must capture this so revert can undo
      const patch = await run(tmp.path, (snapshot) => snapshot.patch(initial!))
      expect(patch.files).toContain(fwd(tmp.path, "a.txt"))

      await run(tmp.path, (snapshot) => snapshot.revert([patch]))

      const restoredContent = await fs.readFile(`${tmp.path}/a.txt`, "utf-8")
      expect(restoredContent).not.toBe("DIRTY_TEST")
    },
  })
})

// ============================================================================
// S-02 safety gate: refuse to overwrite uncommitted edits unless forced (HIGH)
// ============================================================================

test("S-02: restore refuses to overwrite uncommitted edits without force", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const initial = await run(tmp.path, (snapshot) => snapshot.track())
      expect(initial).toBeTruthy()

      // Simulate a user's manual, uncommitted edit.
      await Filesystem.write(`${tmp.path}/a.txt`, "UNCOMMITTED_EDIT")

      // Without force: must be refused to avoid silently discarding the edit.
      await expect(run(tmp.path, (snapshot) => snapshot.restore(initial!))).rejects.toThrow(
        /未提交|uncommitted/i,
      )

      // With force: proceeds.
      await expect(
        run(tmp.path, (snapshot) => snapshot.restore(initial!, true)),
      ).resolves.toBeUndefined()
    },
  })
})

test("S-02: hasUncommitted detects manual edits against the baseline", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const initial = await run(tmp.path, (snapshot) => snapshot.track())
      expect(initial).toBeTruthy()

      // Clean worktree relative to baseline => no uncommitted changes.
      expect(await run(tmp.path, (snapshot) => snapshot.hasUncommitted(initial!))).toBe(false)

      // Simulate a user's manual, uncommitted edit.
      await Filesystem.write(`${tmp.path}/a.txt`, "UNCOMMITTED_EDIT")
      expect(await run(tmp.path, (snapshot) => snapshot.hasUncommitted(initial!))).toBe(true)

      // A fresh track establishes a new baseline; relative to it the worktree
      // (now "UNCOMMITTED_EDIT") is clean again.
      const next = await run(tmp.path, (snapshot) => snapshot.track())
      expect(await run(tmp.path, (snapshot) => snapshot.hasUncommitted(next!))).toBe(false)
    },
  })
})

// ============================================================================
// D: regression tests for snapshot defects (track description passthrough,
//    revert double-rollback S-02 surface, restore keeps out-of-snapshot files)
// ============================================================================

test("track with description writes a commit carrying the description (S-05 reachable)", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // track() returns [hash, shadowGitdir] so we can inspect the object store.
      const [hash, gitdir] = await run(tmp.path, (snapshot) =>
        Effect.gen(function* () {
          const h = yield* snapshot.track("pre-edit snapshot")
          const s = yield* snapshot.stats()
          return [h, s.gitdir] as const
        }),
      )
      expect(hash).toBeTruthy()

      // With a description, S-05 wraps the tree in a commit-tree object inside the
      // *shadow* snapshot repo (not the user's .git). Verify the hash is a commit
      // whose message embeds the description.
      const cat = await $`git --git-dir ${gitdir} cat-file -t ${hash}`.quiet().text()
      expect(cat.trim()).toBe("commit")

      const msg = await $`git --git-dir ${gitdir} log --format=%s -1 ${hash}`.quiet().text()
      expect(msg).toContain("pre-edit snapshot")
    },
  })
})

test("track without description keeps deterministic tree hash (change-detection invariant)", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const [hash1, hash2, gitdir] = await run(tmp.path, (snapshot) =>
        Effect.gen(function* () {
          const h1 = yield* snapshot.track()
          const h2 = yield* snapshot.track()
          const s = yield* snapshot.stats()
          return [h1, h2, s.gitdir] as const
        }),
      )
      // Deterministic: same worktree state => identical tree hash.
      expect(hash1).toBe(hash2)

      // No description => tree hash, not a commit object (in the shadow repo).
      const type = await $`git --git-dir ${gitdir} cat-file -t ${hash1}`.quiet().text()
      expect(type.trim()).toBe("tree")
    },
  })
})

test("hasUncommitted is not blinded by track()/patch() staging (defect B fixed by B1)", async () => {
  // Core regression lock for defect B (fixed by B1). The old check compared the
  // shadow *index* (via diff-files / ls-files --others), but track() and patch()
  // run `git add -A`, which stages the very edits we want to protect into that
  // index — so the gate was blind. B1 builds a throwaway index from the CURRENT
  // worktree and diffs the baseline tree against it, so the persistent shadow
  // index (staged by patch) can neither pollute nor blind the check.
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const initial = await run(tmp.path, (snapshot) => snapshot.track())
      expect(initial).toBeTruthy()

      // Create a change and patch() it — this runs `add -A`, staging the NEW
      // file into the persistent shadow index (the exact move that used to blind
      // S-02). With B1 the new file is now correctly seen as uncommitted.
      await Filesystem.write(`${tmp.path}/new.txt`, "NEW")
      await run(tmp.path, (snapshot) => snapshot.patch(initial!))
      // B1 detects the untracked new.txt (correct, was invisible before).
      expect(await run(tmp.path, (snapshot) => snapshot.hasUncommitted(initial!))).toBe(true)

      // Now the user manually edits a file that EXISTS in the baseline.
      await Filesystem.write(`${tmp.path}/a.txt`, "USER_EDIT")
      // B1 MUST still detect this even though the shadow index was staged by patch().
      expect(await run(tmp.path, (snapshot) => snapshot.hasUncommitted(initial!))).toBe(true)
    },
  })
})

test("hasUncommitted detects a freshly created untracked file (defect B, new-file case)", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const initial = await run(tmp.path, (snapshot) => snapshot.track())
      expect(initial).toBeTruthy()

      // File created AFTER the snapshot, never staged by the user.
      await Filesystem.write(`${tmp.path}/brand-new.txt`, "I should survive a rollback")
      expect(await run(tmp.path, (snapshot) => snapshot.hasUncommitted(initial!))).toBe(true)
    },
  })
})

// ============================================================================
// Hardening: failure-path, cleanup, and conservative-fallback guarantees
// (engineering robustness beyond the functional defects A/B/C/D/E).
// ============================================================================

test("hasUncommitted works for both tree-ish and commit-ish baselines (S-05 compat)", async () => {
  // A returns a commit-ish when described, a tree-ish when not. hasUncommitted
  // (B1) diffs a tree object, so it must accept either form as `baseline`.
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const [treeHash, commitHash] = await run(tmp.path, (snapshot) =>
        Effect.gen(function* () {
          const t = yield* snapshot.track()
          const c = yield* snapshot.track("described baseline")
          return [t, c] as const
        }),
      )
      expect(treeHash).toBeTruthy()
      expect(commitHash).toBeTruthy()

      // Clean worktree relative to each baseline form.
      expect(await run(tmp.path, (snapshot) => snapshot.hasUncommitted(treeHash!))).toBe(false)
      expect(await run(tmp.path, (snapshot) => snapshot.hasUncommitted(commitHash!))).toBe(false)

      await Filesystem.write(`${tmp.path}/a.txt`, "UNCOMMITTED_EDIT")
      expect(await run(tmp.path, (snapshot) => snapshot.hasUncommitted(treeHash!))).toBe(true)
      expect(await run(tmp.path, (snapshot) => snapshot.hasUncommitted(commitHash!))).toBe(true)
    },
  })
})

test("hasUncommitted is conservative: returns true on git failure (no silent overwrite)", async () => {
  // If the git plumbing fails (e.g. corrupt snapshot repo, interrupted GC),
  // hasUncommitted must FAIL CLOSED (report uncommitted) so restore() never
  // silently discards the user's edits. Verified at the unit level by pointing
  // the check at a non-existent baseline object: diff-tree cannot resolve it,
  // the code path returns true rather than false.
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const initial = await run(tmp.path, (snapshot) => snapshot.track())
      expect(initial).toBeTruthy()

      // A baseline that does not exist in the snapshot repo => resolution fails
      // => conservative TRUE (treated as having uncommitted changes).
      expect(await run(tmp.path, (snapshot) => snapshot.hasUncommitted("deadbeef".repeat(5)))).toBe(true)
    },
  })
})

test("hasUncommitted does not leak a temporary index file", async () => {
  // B1 builds a throwaway index via GIT_INDEX_FILE. The success AND failure
  // paths must both remove it, otherwise stale temp indexes accumulate in the
  // snapshot repo and could confuse later runs.
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const [hash, gitdir] = await run(tmp.path, (snapshot) =>
        Effect.gen(function* () {
          const h = yield* snapshot.track()
          const s = yield* snapshot.stats()
          return [h, s.gitdir] as const
        }),
      )
      expect(hash).toBeTruthy()

      await Filesystem.write(`${tmp.path}/a.txt`, "EDIT")
      await run(tmp.path, (snapshot) => snapshot.hasUncommitted(hash!))

      // Temp index used by hasUncommitted must be gone after the call. The name
      // is unique per call (`index.hasuncommitted.<ts>.<seq>`, so concurrent
      // calls cannot share a path), hence the prefix scan rather than an exact
      // filename — asserting the old fixed name made this check vacuous.
      const leftovers = async () =>
        (await fs.readdir(gitdir)).filter((f) => f.startsWith("index.hasuncommitted"))
      expect(await leftovers()).toEqual([])

      // Also exercise the conservative-failure path (bad baseline) and ensure
      // cleanup happens there too.
      await run(tmp.path, (snapshot) => snapshot.hasUncommitted("deadbeef".repeat(5)))
      expect(await leftovers()).toEqual([])
    },
  })
})

test("restore with force rolls back fully even over real uncommitted edits", async () => {
  // S-02 force branch: the gate refuses non-forced restore, but WITH force it
  // must still perform a COMPLETE, correct rollback (including E1 removal of
  // post-snapshot files) without losing snapshot-tracked content.
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const initial = await run(tmp.path, (snapshot) => snapshot.track())
      expect(initial).toBeTruthy()

      // User manually edits an existing file AND creates a new one.
      await Filesystem.write(`${tmp.path}/a.txt`, "MANUAL_EDIT")
      await Filesystem.write(`${tmp.path}/post.txt`, "CREATED_AFTER")

      await run(tmp.path, (snapshot) => snapshot.restore(initial!, true))

      // Snapshot content restored.
      expect(await fs.readFile(`${tmp.path}/a.txt`, "utf-8")).toBe(tmp.extra.aContent)
      // Post-snapshot file removed by the force path too.
      expect(
        await fs
          .access(`${tmp.path}/post.txt`)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})

test("restore with invalid snapshot hash leaves the worktree untouched", async () => {
  // Hardening: a garbled/unknown snapshot must NOT delete or mutate user files.
  // read-tree fails, so restore should abort before any checkout / E1 cleanup.
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()

      await Filesystem.write(`${tmp.path}/a.txt`, "PRECIOUS")
      await Filesystem.write(`${tmp.path}/witness.txt`, "WITNESS")

      // Invalid hash => read-tree fails => the failure is REPORTED to the
      // caller (P1-29), not swallowed into a fake success — while the worktree
      // is still left untouched.
      await expect(
        run(tmp.path, (snapshot) => snapshot.restore("zzzzzzzz".repeat(5), true)),
      ).rejects.toThrow()

      // Unchanged.
      expect(await fs.readFile(`${tmp.path}/a.txt`, "utf-8")).toBe("PRECIOUS")
      expect(await fs.readFile(`${tmp.path}/witness.txt`, "utf-8")).toBe("WITNESS")
    },
  })
})

test("restore removes post-snapshot subdirectory (E1 nested cleanup)", async () => {
  // E1 must delete not just top-level post-snapshot files but whole subtrees
  // that did not exist in the snapshot. The throwaway-index ls-files set
  // includes nested paths, so the difference covers directories too.
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const initial = await run(tmp.path, (snapshot) => snapshot.track())
      expect(initial).toBeTruthy()

      await $`mkdir -p ${tmp.path}/newdir/sub`.quiet()
      await Filesystem.write(`${tmp.path}/newdir/sub/created.txt`, "AFTER")

      await run(tmp.path, (snapshot) => snapshot.restore(initial!, true))

      expect(
        await fs
          .access(`${tmp.path}/newdir/sub/created.txt`)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
      expect(
        await fs
          .access(`${tmp.path}/newdir`)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})

test("restore does not leak its temporary index file", async () => {
  // Mirror of the hasUncommitted cleanup check, but for restore's E1 pass
  // (index.restore-cleanup). Both the success and the failure branch must
  // remove it.
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const [hash, gitdir] = await run(tmp.path, (snapshot) =>
        Effect.gen(function* () {
          const h = yield* snapshot.track()
          const s = yield* snapshot.stats()
          return [h, s.gitdir] as const
        }),
      )
      expect(hash).toBeTruthy()

      await Filesystem.write(`${tmp.path}/a.txt`, "EDIT")
      await run(tmp.path, (snapshot) => snapshot.restore(hash!, true))

      expect(await fs.access(`${gitdir}/index.restore-cleanup`).then(() => true).catch(() => false)).toBe(false)

      // Failure branch (invalid snapshot) must also clean up. The failure is
      // surfaced to the caller (P1-29) rather than silently swallowed.
      await expect(
        run(tmp.path, (snapshot) => snapshot.restore("zzzzzzzz".repeat(5), true)),
      ).rejects.toThrow()
      expect(await fs.access(`${gitdir}/index.restore-cleanup`).then(() => true).catch(() => false)).toBe(false)
    },
  })
})

test("concurrent track on the SAME project serializes via the gitdir lock", async () => {
  // Hardening: two simultaneous track() calls against one project must not
  // corrupt the snapshot repo (the per-gitdir Semaphore serializes them). We
  // fire many in parallel and assert every call returns a valid hash and the
  // repo stays intact (stats().exists and a readable tree).
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Filesystem.write(`${tmp.path}/c1.txt`, "1")
      await Filesystem.write(`${tmp.path}/c2.txt`, "2")

      const results = await Promise.all(
        Array.from({ length: 12 }, () => run(tmp.path, (snapshot) => snapshot.track())),
      )
      for (const h of results) expect(h).toBeTruthy()

      // Repo still healthy: stats report exists and the most recent tree reads.
      const [last, stat] = await run(tmp.path, (snapshot) =>
        Effect.gen(function* () {
          const h = yield* snapshot.track()
          const s = yield* snapshot.stats()
          return [h, s] as const
        }),
      )
      expect(stat.exists).toBe(true)
      const gitdir = stat.gitdir
      const type = await $`git --git-dir ${gitdir} cat-file -t ${last}`.quiet().text()
      expect(type.trim()).toBe("tree")
    },
  })
})

test("a stale gitdir lock file does not wedge snapshot operations (P1-30)", async () => {
  // The shadow gitdir is shared with the Rust sidecar, which uses the SAME
  // lock file (`duoduo.lock`, `<pid>\n<unix_millis>`). A lock left behind by a
  // crashed process must be taken over instead of blocking every snapshot
  // operation forever — and a completed operation must release it again.
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const gitdir = await run(tmp.path, (snapshot) =>
        Effect.gen(function* () {
          expect(yield* snapshot.track()).toBeTruthy()
          return (yield* snapshot.stats()).gitdir
        }),
      )

      // 4294967294 is not a valid live pid on any supported platform; the
      // timestamp is fresh, so only the dead-pid rule can break the lock.
      await Filesystem.write(`${gitdir}/duoduo.lock`, `4294967294\n${Date.now()}\n`)
      expect(await run(tmp.path, (snapshot) => snapshot.track())).toBeTruthy()

      // Released again, so the next operation is not blocked either.
      expect(
        await fs
          .access(`${gitdir}/duoduo.lock`)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})

test("restore removes files created after the snapshot (defect E fixed by E1)", async () => {
  // Regression lock for defect E (fixed by E1). restore() now performs a
  // COMPLETE rollback, matching revert(): after checking out the baseline
  // files, any file that did NOT exist in the snapshot (created afterward) is
  // removed. `.git` must never be touched.
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const initial = await run(tmp.path, (snapshot) => snapshot.track())
      expect(initial).toBeTruthy()

      await $`rm ${tmp.path}/a.txt`.quiet()
      await Filesystem.write(`${tmp.path}/after-snapshot.txt`, "CREATED_AFTER")

      await run(tmp.path, (snapshot) => snapshot.restore(initial!, true))

      // Snapshot file restored.
      expect(
        await fs
          .access(`${tmp.path}/a.txt`)
          .then(() => true)
          .catch(() => false),
      ).toBe(true)
      // Out-of-snapshot file removed (E1 unified rollback semantics).
      expect(
        await fs
          .access(`${tmp.path}/after-snapshot.txt`)
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
      // The shadow .git repo is untouched.
      expect(
        await fs
          .access(`${tmp.path}/.git`)
          .then(() => true)
          .catch(() => false),
      ).toBe(true)
    },
  })
})

// ASCII control for the unicode cases below: proves the revert semantics are
// identical, so a unicode-only failure is an encoding bug, not a setup artifact.
test("revert restores a modified file whose name is pure ASCII", async () => {
  await using tmp = await bootstrap()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const asciiFile = fwd(tmp.path, "ascii-control.txt")
      await Filesystem.write(asciiFile, "original ascii")
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()
      await Filesystem.write(asciiFile, "modified ascii")
      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))
      expect(patch.files).toContain(asciiFile)
      await run(tmp.path, (snapshot) => snapshot.revert([patch]))
      expect(await fs.readFile(asciiFile, "utf-8")).toBe("original ascii")
    },
  })
})

// Batched revert path: >=2 files go through the `ls-tree` batching branch,
// which used to octal-escape non-ASCII names and then DELETE those files.
test("revert restores modified non-ASCII filenames (batched path)", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Filesystem.write(`${dir}/文件.txt`, "original chinese")
      await Filesystem.write(`${dir}/файл.txt`, "original cyrillic")
      await $`git add .`.cwd(dir).quiet()
      await $`git commit -m init`.cwd(dir).quiet()
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const chineseFile = fwd(tmp.path, "文件.txt")
      const cyrillicFile = fwd(tmp.path, "файл.txt")
      const before = await run(tmp.path, (snapshot) => snapshot.track())
      expect(before).toBeTruthy()
      await Filesystem.write(chineseFile, "modified chinese")
      await Filesystem.write(cyrillicFile, "modified cyrillic")
      const patch = await run(tmp.path, (snapshot) => snapshot.patch(before!))
      expect(patch.files).toContain(chineseFile)
      expect(patch.files).toContain(cyrillicFile)
      await run(tmp.path, (snapshot) => snapshot.revert([patch]))
      expect(await fs.readFile(chineseFile, "utf-8")).toBe("original chinese")
      expect(await fs.readFile(cyrillicFile, "utf-8")).toBe("original cyrillic")
    },
  })
})

// `restore` builds its "keep" set from `ls-tree` while the current worktree set
// comes from `ls-files -z`. A encoding mismatch between the two deleted every
// non-ASCII file instead of restoring it.
test("restore restores non-ASCII filenames instead of deleting them", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      await Filesystem.write(`${dir}/文件.txt`, "original chinese")
      await Filesystem.write(`${dir}/plain.txt`, "original plain")
      await $`git add .`.cwd(dir).quiet()
      await $`git commit -m init`.cwd(dir).quiet()
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const initial = await run(tmp.path, (snapshot) => snapshot.track())
      expect(initial).toBeTruthy()

      await Filesystem.write(fwd(tmp.path, "文件.txt"), "modified chinese")
      await Filesystem.write(fwd(tmp.path, "plain.txt"), "modified plain")
      await Filesystem.write(fwd(tmp.path, "post.txt"), "created after")

      await run(tmp.path, (snapshot) => snapshot.restore(initial!, true))

      // Files that existed in the snapshot must be RESTORED, not deleted.
      expect(await fs.readFile(fwd(tmp.path, "文件.txt"), "utf-8")).toBe("original chinese")
      expect(await fs.readFile(fwd(tmp.path, "plain.txt"), "utf-8")).toBe("original plain")
      // A file created after the snapshot must be REMOVED (E1 semantics).
      expect(
        await fs
          .access(fwd(tmp.path, "post.txt"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false)
    },
  })
})
