import { describe, expect, test } from "bun:test"
import type { FilePart, FilePartSourceText } from "@duoduo-ai/sdk/v2"
import { attached, inline, kind } from "./message-file"

function file(part: Partial<FilePart> = {}): FilePart {
  return {
    id: "part_1",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "file",
    mime: "text/plain",
    url: "file:///repo/README.txt",
    filename: "README.txt",
    ...part,
  }
}

describe("message-file", () => {
  test("attached: data URLs are attachments", () => {
    expect(attached(file({ url: "data:text/plain;base64,SGVsbG8=" }))).toBe(true)
  })

  test("attached: file:// URLs without source.text are attachments", () => {
    expect(attached(file())).toBe(true)
  })

  test("attached: file:// URLs with source.text are not attachments", () => {
    expect(
      attached(
        file({
          source: {
            type: "file",
            path: "/repo/README.txt",
            text: { value: "@README.txt", start: 0, end: 11 },
          },
        }),
      ),
    ).toBe(false)
  })

  test("attached: other URLs are not attachments", () => {
    expect(attached(file({ url: "https://example.com/file.txt" }))).toBe(false)
  })

  test("inline: only non-attachment source ranges are inline references", () => {
    // file:// with source.text → not attached → inline (has start & end)
    expect(
      inline(
        file({
          source: {
            type: "file",
            path: "/repo/README.txt",
            text: { value: "@README.txt", start: 0, end: 11 },
          },
        }),
      ),
    ).toBe(true)

    // data: URL → attached → never inline, even with source.text
    expect(
      inline(
        file({
          url: "data:text/plain;base64,SGVsbG8=",
          source: {
            type: "file",
            path: "/repo/README.txt",
            text: { value: "@README.txt", start: 0, end: 11 },
          },
        }),
      ),
    ).toBe(false)

    // file:// without source.text → attached → not inline
    expect(inline(file())).toBe(false)

    // file:// with source but missing start/end → not inline
    expect(
      inline(
        file({
          source: {
            type: "file",
            path: "/repo/README.txt",
            text: { value: "@README.txt" } as unknown as FilePartSourceText,
          },
        }),
      ),
    ).toBe(false)
  })

  test("kind: separates image and file attachment kinds", () => {
    expect(kind(file({ mime: "image/png" }))).toBe("image")
    expect(kind(file({ mime: "application/pdf" }))).toBe("file")
  })
})
