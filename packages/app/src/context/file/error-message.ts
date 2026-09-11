export function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  // SDK throwOnError: true throws the parsed JSON response body as a plain object.
  // This is the most common case: { error: "..." } from backend 4xx/5xx responses.
  if (error && typeof error === "object" && !Array.isArray(error)) {
    // Skip Error instances that already failed the first branch (e.g. empty message)
    if (error instanceof Error) return fallback
    const obj = error as Record<string, unknown>
    // Backend NamedError format: { name: "...", data: { message: "..." } }
    if (typeof obj.data === "object" && obj.data !== null && !Array.isArray(obj.data)) {
      const data = obj.data as Record<string, unknown>
      if (typeof data.message === "string" && data.message) return data.message
      // data may itself contain nested fields
      if (typeof data.error === "string" && data.error) return data.error
    }
    // Direct { error: "..." } format from file routes
    if (typeof obj.error === "string" && obj.error) return obj.error
    // Fallback: try message field
    if (typeof obj.message === "string" && obj.message) return obj.message
    // Fallback: try name as identifier (e.g. "UnknownError")
    if (typeof obj.name === "string" && obj.name) return obj.name
    // Last resort: stringify the whole object for visibility
    try {
      const str = JSON.stringify(obj)
      if (str && str !== "{}" && str !== "[]") return str
    } catch {
      // ignore
    }
  }
  return fallback
}
