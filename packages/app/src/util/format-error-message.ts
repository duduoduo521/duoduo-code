/**
 * Best-effort conversion of an unknown thrown value (Error, string, hey-api
 * response error, fetch failure, plain object…) into a human-readable
 * string suitable for showing in toasts / inline error banners.
 *
 * Why this exists: the default `String(err)` for plain objects renders as
 * the useless "[object Object]" in the DOM, and SDK errors are usually
 * nested (`{ data: { error: "…" } }` for non-2xx responses). Both must be
 * flattened before being assigned to a `<Show>{error()}</Show>` string signal.
 */
export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>
    // Backend errors are usually `{ error: "..." }`
    if (typeof obj.error === "string") return obj.error
    // hey-api may wrap the backend body as `{ data: { error: "..." } }`
    if (
      obj.data &&
      typeof obj.data === "object" &&
      typeof (obj.data as Record<string, unknown>).error === "string"
    ) {
      return (obj.data as Record<string, unknown>).error as string
    }
    if (typeof obj.message === "string") return obj.message
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}
