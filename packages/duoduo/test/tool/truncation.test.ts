import { describe, test, expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem, Layer } from "effect"
import { Truncate } from "../../src/tool"
import { Identifier } from "../../src/id/id"
import { Process } from "../../src/util"
import { Filesystem } from "../../src/util"
import path from "path"
import { testEffect } from "../lib/effect"
import { writeFileStringScoped } from "../lib/filesystem"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")
const ROOT = path.resolve(import.meta.dir, "..", "..")

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, NodeFileSystem.layer))

describe("Truncate", () => {
  describe("output", () => {
    it.live("truncates large json file by bytes", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = yield* Effect.promise(() => Filesystem.readText(path.join(FIXTURES_DIR, "models-api.json")))
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("truncated...")
        if (result.truncated) expect(result.outputPath).toBeDefined()
      }),
    )

    it.live("returns content unchanged when under limits", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "line1\nline2\nline3"
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(false)
        expect(result.content).toBe(content)
      }),
    )

    it.live("truncates by line count", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("...90 lines truncated...")
      }),
    )

    it.live("truncates by byte count", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "a".repeat(1000)
        const result = yield* svc.output(content, { maxBytes: 100 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("truncated...")
      }),
    )

    it.live("truncates from head by default", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 3 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line0")
        expect(result.content).toContain("line1")
        expect(result.content).toContain("line2")
        expect(result.content).not.toContain("line9")
      }),
    )

    it.live("truncates from tail when direction is tail", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 3, direction: "tail" })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line7")
        expect(result.content).toContain("line8")
        expect(result.content).toContain("line9")
        expect(result.content).not.toContain("line0")
      }),
    )

    test("uses default MAX_LINES and MAX_BYTES", () => {
      expect(Truncate.MAX_LINES).toBe(2000)
      expect(Truncate.MAX_BYTES).toBe(50 * 1024)
    })

    it.live("large single-line file truncates with byte message", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = yield* Effect.promise(() => Filesystem.readText(path.join(FIXTURES_DIR, "models-api.json")))
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("bytes truncated...")
        expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(Truncate.MAX_BYTES)
      }),
    )

    it.live("writes full output to file when truncated", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("The tool call succeeded but the output was truncated")
        expect(result.content).toContain("Grep")
        if (!result.truncated) throw new Error("expected truncated")
        expect(result.outputPath).toBeDefined()
        expect(result.outputPath).toContain("tool_")

        const written = yield* Effect.promise(() => Filesystem.readText(result.outputPath))
        expect(written).toBe(lines)
      }),
    )

    it.live("suggests Task tool when agent has task permission", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const agent = { permission: [{ permission: "task", pattern: "*", action: "allow" as const }] }
        const result = yield* svc.output(lines, { maxLines: 10 }, agent as any)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("Grep")
        expect(result.content).toContain("Task tool")
      }),
    )

    it.live("omits Task tool hint when agent lacks task permission", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const agent = { permission: [{ permission: "task", pattern: "*", action: "deny" as const }] }
        const result = yield* svc.output(lines, { maxLines: 10 }, agent as any)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("Grep")
        expect(result.content).not.toContain("Task tool")
      }),
    )

    it.live("does not write file when not truncated", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "short content"
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(false)
        if (result.truncated) throw new Error("expected not truncated")
        expect("outputPath" in result).toBe(false)
      }),
    )

    it.live("handles empty content as not truncated", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const result = yield* svc.output("")

        expect(result.truncated).toBe(false)
        expect(result.content).toBe("")
      }),
    )

    it.live("does not truncate content exactly at maxLines boundary", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = Array.from({ length: 3 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(content, { maxLines: 3 })

        expect(result.truncated).toBe(false)
        expect(result.content).toBe(content)
      }),
    )

    it.live("does not truncate content exactly at maxBytes boundary", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "a".repeat(100)
        const result = yield* svc.output(content, { maxBytes: 100 })

        expect(result.truncated).toBe(false)
        expect(result.content).toBe(content)
      }),
    )

    it.live("truncates single line exceeding maxBytes", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        // Single line with no newlines - byte limit will be hit
        const content = "a".repeat(1000)
        const result = yield* svc.output(content, { maxBytes: 50 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("bytes truncated...")
      }),
    )

    it.live("handles multi-byte UTF-8 characters at byte boundary", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        // Each emoji is 4 bytes in UTF-8
        const content = "😀".repeat(20)
        const result = yield* svc.output(content, { maxBytes: 16 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("bytes truncated...")
      }),
    )

    it.live("hits byte limit before line limit with varying line sizes", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        // 3 lines: 2 short + 1 huge line
        const lines = ["short", "also short", "x".repeat(10000)]
        const content = lines.join("\n")
        const result = yield* svc.output(content, { maxLines: 10, maxBytes: 50 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("bytes truncated...")
        expect(result.content).toContain("short")
      }),
    )

    it.live("handles content with blank lines correctly", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "line1\n\n\n\nline5"
        const result = yield* svc.output(content, { maxLines: 3 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line1")
        expect(result.content).toContain("...2 lines truncated...")
      }),
    )

    it.live("uses maxLines=0 to truncate everything", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "line1\nline2"
        const result = yield* svc.output(content, { maxLines: 0 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("...2 lines truncated...")
      }),
    )

    it.live("tail direction with byte limit", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 20 }, (_, i) => `line${i.toString().padStart(2, "0")}`)
        const content = lines.join("\n")
        const result = yield* svc.output(content, { maxLines: 5, maxBytes: 200, direction: "tail" })

        expect(result.truncated).toBe(true)
        // Tail direction keeps the LAST lines
        expect(result.content).toContain("line19")
        expect(result.content).toContain("line15")
      }),
    )

    test("loads truncate effect in a fresh process", async () => {
      const out = await Process.run([process.execPath, "run", path.join(ROOT, "src", "tool", "truncate.ts")], {
        cwd: ROOT,
      })

      expect(out.code).toBe(0)
    }, 20000)
  })

  describe("cleanup", () => {
    const DAY_MS = 24 * 60 * 60 * 1000

    it.live("deletes files older than 7 days and preserves recent files", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fs = yield* FileSystem.FileSystem

        yield* fs.makeDirectory(Truncate.DIR, { recursive: true })

        const old = path.join(Truncate.DIR, Identifier.create("tool", "ascending", Date.now() - 10 * DAY_MS))
        const recent = path.join(Truncate.DIR, Identifier.create("tool", "ascending", Date.now() - 3 * DAY_MS))

        yield* writeFileStringScoped(old, "old content")
        yield* writeFileStringScoped(recent, "recent content")
        yield* svc.cleanup()

        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
      }),
    )
  })
})
