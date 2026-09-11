import { describe, test, expect } from "bun:test"

// ─── Extract pure logic from status-indicator.tsx for testing ───

type SmartLayerStatus = "connected" | "disconnected" | "checking"

function statusLabel(status: SmartLayerStatus, t: (key: string) => string): string {
  switch (status) {
    case "connected":
      return t("smartLayer.status.connected")
    case "disconnected":
      return t("smartLayer.status.disconnected")
    case "checking":
      return t("smartLayer.status.checking")
  }
}

function dotColor(status: SmartLayerStatus): string {
  switch (status) {
    case "connected":
      return "bg-green-500"
    case "disconnected":
      return "bg-red-400"
    case "checking":
      return "bg-yellow-400 animate-pulse"
  }
}

function tooltipText(status: SmartLayerStatus, version: string | null, t: (key: string) => string): string {
  const label = statusLabel(status, t)
  if (status === "connected" && version) {
    return `${label} (v${version})`
  }
  return label
}

// Mock i18n translator
const t = (key: string) => {
  const map: Record<string, string> = {
    "smartLayer.label": "Smart Layer",
    "smartLayer.status.connected": "Connected",
    "smartLayer.status.disconnected": "Disconnected",
    "smartLayer.status.checking": "Checking",
  }
  return map[key] ?? key
}

// ─── Tests ───

describe("smart layer status - label mapping", () => {
  test("connected → 'Connected'", () => {
    expect(statusLabel("connected", t)).toBe("Connected")
  })

  test("disconnected → 'Disconnected'", () => {
    expect(statusLabel("disconnected", t)).toBe("Disconnected")
  })

  test("checking → 'Checking'", () => {
    expect(statusLabel("checking", t)).toBe("Checking")
  })
})

describe("smart layer status - dot color mapping", () => {
  test("connected → green", () => {
    expect(dotColor("connected")).toBe("bg-green-500")
  })

  test("disconnected → red", () => {
    expect(dotColor("disconnected")).toBe("bg-red-400")
  })

  test("checking → yellow with pulse animation", () => {
    expect(dotColor("checking")).toBe("bg-yellow-400 animate-pulse")
  })
})

describe("smart layer status - tooltip text", () => {
  test("connected with version shows version", () => {
    expect(tooltipText("connected", "1.2.3", t)).toBe("Connected (v1.2.3)")
  })

  test("connected without version shows label only", () => {
    expect(tooltipText("connected", null, t)).toBe("Connected")
  })

  test("connected with empty string version shows label only", () => {
    // Empty string is falsy, so falls through to label only
    expect(tooltipText("connected", "", t)).toBe("Connected")
  })

  test("disconnected shows label only", () => {
    expect(tooltipText("disconnected", "1.2.3", t)).toBe("Disconnected")
  })

  test("checking shows label only", () => {
    expect(tooltipText("checking", "1.2.3", t)).toBe("Checking")
  })

  test("disconnected without version shows label", () => {
    expect(tooltipText("disconnected", null, t)).toBe("Disconnected")
  })

  test("checking without version shows label", () => {
    expect(tooltipText("checking", null, t)).toBe("Checking")
  })
})
