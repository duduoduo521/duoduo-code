import { describe, expect, test } from "bun:test"
import { attachmentMime, ACCEPTED_FILE_TYPES } from "./files"

describe("ACCEPTED_FILE_TYPES", () => {
  test("includes image MIME types", () => {
    expect(ACCEPTED_FILE_TYPES).toContain("image/png")
    expect(ACCEPTED_FILE_TYPES).toContain("image/jpeg")
    expect(ACCEPTED_FILE_TYPES).toContain("image/gif")
    expect(ACCEPTED_FILE_TYPES).toContain("image/webp")
  })

  test("includes PDF type", () => {
    expect(ACCEPTED_FILE_TYPES).toContain("application/pdf")
  })

  test("includes text wildcard", () => {
    expect(ACCEPTED_FILE_TYPES).toContain("text/*")
  })
})

describe("attachmentMime", () => {
  test("recognizes image/png from browser mime", async () => {
    const file = new File(["fake-png"], "photo.png", { type: "image/png" })
    expect(await attachmentMime(file)).toBe("image/png")
  })

  test("recognizes image/jpeg from browser mime", async () => {
    const file = new File(["fake-jpg"], "photo.jpg", { type: "image/jpeg" })
    expect(await attachmentMime(file)).toBe("image/jpeg")
  })

  test("recognizes image/gif from browser mime", async () => {
    const file = new File(["fake-gif"], "anim.gif", { type: "image/gif" })
    expect(await attachmentMime(file)).toBe("image/gif")
  })

  test("recognizes image/webp from browser mime", async () => {
    const file = new File(["fake-webp"], "photo.webp", { type: "image/webp" })
    expect(await attachmentMime(file)).toBe("image/webp")
  })

  test("recognizes PDF from browser mime", async () => {
    const file = new File(["%PDF-1.7"], "doc.pdf", { type: "application/pdf" })
    expect(await attachmentMime(file)).toBe("application/pdf")
  })

  test("falls back to image mime from extension when browser reports octet-stream", async () => {
    const file = new File(["fake-png"], "photo.png", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBe("image/png")
  })

  test("falls back to PDF mime from extension when browser reports octet-stream", async () => {
    const file = new File(["%PDF-1.7"], "doc.pdf", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBe("application/pdf")
  })

  test("falls back to image mime from extension when browser reports no type", async () => {
    const file = new File(["fake-jpg"], "photo.jpg", { type: "" })
    expect(await attachmentMime(file)).toBe("image/jpeg")
  })

  test("normalizes application/json to text/plain", async () => {
    const file = new File(['{"ok":true}'], "data.json", { type: "application/json" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("normalizes application/xml to text/plain", async () => {
    const file = new File(["<root/>"], "data.xml", { type: "application/xml" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("normalizes application/yaml to text/plain", async () => {
    const file = new File(["key: val"], "data.yaml", { type: "application/yaml" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("normalizes text/* types to text/plain", async () => {
    const file = new File(["hello"], "note.txt", { type: "text/plain" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("normalizes application/toml to text/plain", async () => {
    const file = new File(["[section]"], "conf.toml", { type: "application/toml" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("recognizes +json suffix types as text", async () => {
    const file = new File(["{}"], "schema.schema+json", { type: "application/schema+json" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("recognizes +xml suffix types as text", async () => {
    const file = new File(["<atom/>"], "feed.atom+xml", { type: "application/atom+xml" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("detects text content by byte sampling when mime is misleading", async () => {
    const file = new File(["export const x = 1\n"], "main.ts", { type: "video/mp2t" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("rejects binary files with null bytes", async () => {
    const file = new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBeUndefined()
  })

  test("rejects binary files with too many control characters", async () => {
    // Create bytes where >30% are control chars (0x01-0x08 range, not 0x00)
    const bytes = new Uint8Array(100)
    for (let i = 0; i < 40; i++) bytes[i] = 1 // 40% control chars
    for (let i = 40; i < 100; i++) bytes[i] = 65 // 'A'
    const file = new File([bytes], "weird.dat", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBeUndefined()
  })

  test("accepts text files with some control chars under 30% threshold", async () => {
    const bytes = new Uint8Array(100)
    for (let i = 0; i < 20; i++) bytes[i] = 10 // newline (0x0A) — in 0x09-0x0D range, not counted as control
    for (let i = 20; i < 100; i++) bytes[i] = 65 // 'A'
    const file = new File([bytes], "mixed.dat", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("accepts empty file as text", async () => {
    const file = new File([], "empty.txt", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("strips charset from mime type", async () => {
    const file = new File(["hello"], "note.txt", { type: "text/plain; charset=utf-8" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("handles file with no extension and unknown mime", async () => {
    const file = new File(["some text content"], "Makefile", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })
})
