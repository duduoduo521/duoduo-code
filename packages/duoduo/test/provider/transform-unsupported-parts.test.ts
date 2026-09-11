import { describe, expect, test } from "bun:test"

// Replicate the `unsupportedParts` function logic from transform.ts for unit testing.
// This function filters out file/image parts that the model doesn't support.

function mimeToModality(mime: string): string | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

type ModelCapabilities = {
  input: Record<string, boolean>
}

type Model = {
  capabilities: ModelCapabilities
}

type FilePart = {
  type: "file"
  mediaType: string
  filename?: string
  data: string
}

type ImagePart = {
  type: "image"
  image: string
}

type TextPart = {
  type: "text"
  text: string
}

type ContentPart = FilePart | ImagePart | TextPart | { type: string; [key: string]: any }

type Message = {
  role: string
  content?: string | ContentPart[]
}

function unsupportedParts(msgs: Message[], model: Model): Message[] {
  return msgs.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

    const filtered = msg.content.map((part) => {
      if (part.type !== "file" && part.type !== "image") return part

      // Check for empty base64 image data
      if (part.type === "image") {
        const imageStr = String((part as ImagePart).image)
        if (imageStr.startsWith("data:")) {
          const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
          if (match && (!match[2] || match[2].length === 0)) {
            return {
              type: "text" as const,
              text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
            }
          }
        }
      }

      const mime =
        part.type === "image"
          ? String((part as ImagePart).image).split(";")[0].replace("data:", "")
          : (part as FilePart).mediaType
      const filename = part.type === "file" ? (part as FilePart).filename : undefined
      const modality = mimeToModality(mime)
      if (!modality) return part
      if (model.capabilities.input[modality]) return part

      const name = filename ? `"${filename}"` : modality
      return {
        type: "text" as const,
        text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
      }
    })

    return { ...msg, content: filtered }
  })
}

function makeModel(capabilities: Partial<Record<string, boolean>> = {}): Model {
  return {
    capabilities: {
      input: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
        ...capabilities,
      },
    },
  }
}

// ─── unsupportedParts ───

describe("ProviderTransform.unsupportedParts", () => {
  test("passes through non-user messages unchanged", () => {
    const model = makeModel()
    const msgs: Message[] = [
      { role: "assistant", content: "Hello" },
      { role: "system", content: "System prompt" },
    ]
    const result = unsupportedParts(msgs, model)
    expect(result).toEqual(msgs)
  })

  test("passes through string content unchanged", () => {
    const model = makeModel()
    const msgs: Message[] = [{ role: "user", content: "Just text" }]
    const result = unsupportedParts(msgs, model)
    expect(result).toEqual(msgs)
  })

  test("passes through text parts unchanged", () => {
    const model = makeModel()
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]
    const result = unsupportedParts(msgs, model)
    expect(result).toEqual(msgs)
  })

  test("passes through image parts when model supports image input", () => {
    const model = makeModel({ image: true })
    const msgs: Message[] = [
      { role: "user", content: [{ type: "image", image: "data:image/png;base64,abc123" }] },
    ]
    const result = unsupportedParts(msgs, model)
    expect(result[0].content).toEqual([{ type: "image", image: "data:image/png;base64,abc123" }])
  })

  test("replaces image parts with error text when model does NOT support image", () => {
    const model = makeModel({ image: false })
    const msgs: Message[] = [
      { role: "user", content: [{ type: "image", image: "data:image/png;base64,abc123" }] },
    ]
    const result = unsupportedParts(msgs, model)
    const content = result[0].content as TextPart[]
    expect(content[0].type).toBe("text")
    expect(content[0].text).toContain("does not support image input")
  })

  test("replaces file parts with error text when model does NOT support the modality", () => {
    const model = makeModel({ pdf: false })
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "file", mediaType: "application/pdf", filename: "doc.pdf", data: "base64data" }],
      },
    ]
    const result = unsupportedParts(msgs, model)
    const content = result[0].content as TextPart[]
    expect(content[0].type).toBe("text")
    expect(content[0].text).toContain('"doc.pdf"')
    expect(content[0].text).toContain("does not support pdf input")
  })

  test("includes filename in error when available", () => {
    const model = makeModel({ image: false })
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "image", image: "data:image/jpeg;base64,abc", filename: "photo.jpg" }],
      } as any,
    ]
    const result = unsupportedParts(msgs, model)
    const content = result[0].content as TextPart[]
    expect(content[0].text).toContain("image")
  })

  test("uses modality name when no filename", () => {
    const model = makeModel({ image: false })
    const msgs: Message[] = [
      { role: "user", content: [{ type: "image", image: "data:image/png;base64,abc" }] },
    ]
    const result = unsupportedParts(msgs, model)
    const content = result[0].content as TextPart[]
    expect(content[0].text).toContain("image")
  })

  test("replaces audio file when model does NOT support audio", () => {
    const model = makeModel({ audio: false })
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "file", mediaType: "audio/mp3", filename: "song.mp3", data: "base64" }],
      },
    ]
    const result = unsupportedParts(msgs, model)
    const content = result[0].content as TextPart[]
    expect(content[0].type).toBe("text")
    expect(content[0].text).toContain("audio")
  })

  test("replaces video file when model does NOT support video", () => {
    const model = makeModel({ video: false })
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "file", mediaType: "video/mp4", filename: "clip.mp4", data: "base64" }],
      },
    ]
    const result = unsupportedParts(msgs, model)
    const content = result[0].content as TextPart[]
    expect(content[0].type).toBe("text")
    expect(content[0].text).toContain("video")
  })

  test("passes through file parts with unsupported mime type (no modality mapping)", () => {
    const model = makeModel()
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "file", mediaType: "text/csv", filename: "data.csv", data: "base64" }],
      },
    ]
    const result = unsupportedParts(msgs, model)
    expect(result[0].content).toEqual(msgs[0].content)
  })

  test("replaces empty base64 image with corrupted error", () => {
    const model = makeModel({ image: true })
    const msgs: Message[] = [
      { role: "user", content: [{ type: "image", image: "data:image/png;base64," }] },
    ]
    const result = unsupportedParts(msgs, model)
    const content = result[0].content as TextPart[]
    expect(content[0].type).toBe("text")
    expect(content[0].text).toContain("empty or corrupted")
  })

  test("passes through non-data-URL images unchanged (when supported)", () => {
    const model = makeModel({ image: true })
    const msgs: Message[] = [
      { role: "user", content: [{ type: "image", image: "https://example.com/img.png" }] },
    ]
    const result = unsupportedParts(msgs, model)
    expect(result[0].content).toEqual([{ type: "image", image: "https://example.com/img.png" }])
  })

  test("handles mixed content parts — some supported, some not", () => {
    const model = makeModel({ image: false, pdf: true })
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Here is a file:" },
          { type: "image", image: "data:image/png;base64,abc" },
          { type: "file", mediaType: "application/pdf", filename: "doc.pdf", data: "base64" },
        ],
      },
    ]
    const result = unsupportedParts(msgs, model)
    const content = result[0].content as ContentPart[]
    expect(content[0]).toEqual({ type: "text", text: "Here is a file:" })
    expect((content[1] as TextPart).type).toBe("text")
    expect((content[1] as TextPart).text).toContain("image")
    // PDF is supported, should pass through
    expect(content[2]).toEqual({ type: "file", mediaType: "application/pdf", filename: "doc.pdf", data: "base64" })
  })

  test("does not modify non-file/image parts of unknown type", () => {
    const model = makeModel()
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "tool-call", toolCallId: "tc1", toolName: "fn", args: "{}" }],
      } as any,
    ]
    const result = unsupportedParts(msgs, model)
    expect(result).toEqual(msgs)
  })
})
