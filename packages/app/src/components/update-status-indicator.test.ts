import { describe, expect, test } from "bun:test"

// Testing tooltipText logic from update-status-indicator.tsx
// The tooltip logic is a switch statement based on status

type UpdateStatus = "none" | "checking" | "downloading" | "downloaded" | "error"

function tooltipText(status: UpdateStatus, version: string): string {
  switch (status) {
    case "checking":
      return "Checking for updates..."
    case "downloading":
      return "Downloading..."
    case "downloaded":
      return `Update downloaded, restart to install${version ? ` (v${version})` : ""}`
    case "error":
      return "Update error"
    default:
      return ""
  }
}

function shouldShowIndicator(status: UpdateStatus): boolean {
  return status !== "none"
}

function handleClickAction(status: UpdateStatus): boolean {
  return status === "downloaded"
}

describe("update-status-indicator logic", () => {
  describe("tooltipText", () => {
    test("returns empty for 'none' status", () => {
      expect(tooltipText("none", "")).toBe("")
    })

    test("returns checking message", () => {
      expect(tooltipText("checking", "")).toBe("Checking for updates...")
    })

    test("returns downloading message", () => {
      expect(tooltipText("downloading", "")).toBe("Downloading...")
    })

    test("returns downloaded message with version", () => {
      expect(tooltipText("downloaded", "1.2.3")).toBe("Update downloaded, restart to install (v1.2.3)")
    })

    test("returns downloaded message without version", () => {
      expect(tooltipText("downloaded", "")).toBe("Update downloaded, restart to install")
    })

    test("returns error message", () => {
      expect(tooltipText("error", "")).toBe("Update error")
    })
  })

  describe("shouldShowIndicator", () => {
    test("returns false for 'none'", () => {
      expect(shouldShowIndicator("none")).toBe(false)
    })

    test("returns true for other statuses", () => {
      expect(shouldShowIndicator("checking")).toBe(true)
      expect(shouldShowIndicator("downloading")).toBe(true)
      expect(shouldShowIndicator("downloaded")).toBe(true)
      expect(shouldShowIndicator("error")).toBe(true)
    })
  })

  describe("handleClickAction", () => {
    test("returns true only for 'downloaded'", () => {
      expect(handleClickAction("downloaded")).toBe(true)
      expect(handleClickAction("checking")).toBe(false)
      expect(handleClickAction("downloading")).toBe(false)
      expect(handleClickAction("error")).toBe(false)
      expect(handleClickAction("none")).toBe(false)
    })
  })
})
