import { describe, expect, test } from "bun:test"
import { isPdfAttachment, isMedia, isImageAttachment, sniffAttachmentMime } from "../../src/util/media"

describe("util.media", () => {
  describe("isPdfAttachment", () => {
    test("returns true for application/pdf", () => {
      expect(isPdfAttachment("application/pdf")).toBe(true)
    })

    test("returns false for other mime types", () => {
      expect(isPdfAttachment("image/png")).toBe(false)
      expect(isPdfAttachment("text/plain")).toBe(false)
    })
  })

  describe("isMedia", () => {
    test("returns true for image mime types", () => {
      expect(isMedia("image/png")).toBe(true)
      expect(isMedia("image/jpeg")).toBe(true)
      expect(isMedia("image/gif")).toBe(true)
    })

    test("returns true for application/pdf", () => {
      expect(isMedia("application/pdf")).toBe(true)
    })

    test("returns false for non-media types", () => {
      expect(isMedia("text/plain")).toBe(false)
      expect(isMedia("application/json")).toBe(false)
    })
  })

  describe("isImageAttachment", () => {
    test("returns true for common image types", () => {
      expect(isImageAttachment("image/png")).toBe(true)
      expect(isImageAttachment("image/jpeg")).toBe(true)
      expect(isImageAttachment("image/gif")).toBe(true)
      expect(isImageAttachment("image/webp")).toBe(true)
    })

    test("returns false for svg+xml", () => {
      expect(isImageAttachment("image/svg+xml")).toBe(false)
    })

    test("returns false for image/vnd.fastbidsheet", () => {
      expect(isImageAttachment("image/vnd.fastbidsheet")).toBe(false)
    })

    test("returns false for application/pdf", () => {
      expect(isImageAttachment("application/pdf")).toBe(false)
    })
  })

  describe("sniffAttachmentMime", () => {
    test("detects PNG from magic bytes", () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      expect(sniffAttachmentMime(bytes, "application/octet-stream")).toBe("image/png")
    })

    test("detects JPEG from magic bytes", () => {
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
      expect(sniffAttachmentMime(bytes, "application/octet-stream")).toBe("image/jpeg")
    })

    test("detects GIF from magic bytes", () => {
      const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
      expect(sniffAttachmentMime(bytes, "application/octet-stream")).toBe("image/gif")
    })

    test("detects BMP from magic bytes", () => {
      const bytes = new Uint8Array([0x42, 0x4d, 0x00, 0x00])
      expect(sniffAttachmentMime(bytes, "application/octet-stream")).toBe("image/bmp")
    })

    test("detects PDF from magic bytes", () => {
      const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])
      expect(sniffAttachmentMime(bytes, "application/octet-stream")).toBe("application/pdf")
    })

    test("detects WebP from magic bytes (RIFF + WEBP)", () => {
      const bytes = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x00, 0x00, 0x00, 0x00, // file size
        0x57, 0x45, 0x42, 0x50, // WEBP
      ])
      expect(sniffAttachmentMime(bytes, "application/octet-stream")).toBe("image/webp")
    })

    test("returns fallback when no magic bytes match", () => {
      const bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03])
      expect(sniffAttachmentMime(bytes, "text/plain")).toBe("text/plain")
    })

    test("returns custom fallback", () => {
      const bytes = new Uint8Array([0x00])
      expect(sniffAttachmentMime(bytes, "custom/fallback")).toBe("custom/fallback")
    })
  })
})
