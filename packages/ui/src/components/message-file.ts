import type { FilePart } from "@duoduo-ai/sdk/v2"

export function attached(part: FilePart) {
  if (part.url.startsWith("data:")) return true
  // Context items (added from file tree) have file:// URLs without source.text —
  // treat them as attachments so they render as file cards in the message list.
  if (part.url.startsWith("file:") && !part.source?.text) return true
  return false
}

export function inline(part: FilePart) {
  if (attached(part)) return false
  return part.source?.text?.start !== undefined && part.source?.text?.end !== undefined
}

export function kind(part: FilePart) {
  return part.mime.startsWith("image/") ? "image" : "file"
}
