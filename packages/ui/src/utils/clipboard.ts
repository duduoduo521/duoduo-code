/**
 * Copy `value` to the clipboard.
 *
 * Prefers the async Clipboard API, but falls back to a hidden `<textarea>` +
 * `execCommand("copy")` for environments where `navigator.clipboard` is
 * unavailable or blocked — this is the common case inside Tauri webviews
 * (especially release builds), where the raw `navigator.clipboard.writeText`
 * call would throw and the copy button would appear to do nothing.
 *
 * Returns `true` if the copy succeeded, `false` otherwise. Never throws.
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof value !== "string" || value.length === 0) return false

  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(value)
      return true
    } catch {
      // Fall through to the legacy path below.
    }
  }

  try {
    const textarea = document.createElement("textarea")
    textarea.value = value
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.top = "-9999px"
    textarea.style.left = "-9999px"
    textarea.style.opacity = "0"
    textarea.style.pointerEvents = "none"
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}
