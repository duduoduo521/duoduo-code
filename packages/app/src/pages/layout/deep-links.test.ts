import { describe, expect, test } from "bun:test"
import {
  parseDeepLink,
  parseNewSessionDeepLink,
  collectOpenProjectDeepLinks,
  collectNewSessionDeepLinks,
  drainPendingDeepLinks,
} from "./deep-links"

describe("parseDeepLink", () => {
  test("parses valid open-project deep link", () => {
    expect(parseDeepLink("duoduo://open-project?directory=/home/user")).toBe("/home/user")
  })

  test("parses open-project with encoded directory", () => {
    expect(parseDeepLink("duoduo://open-project?directory=/path%20with%20spaces")).toBe("/path with spaces")
  })

  test("returns undefined for non-duoduo URL", () => {
    expect(parseDeepLink("https://example.com")).toBeUndefined()
  })

  test("returns undefined for duoduo URL with wrong hostname", () => {
    expect(parseDeepLink("duoduo://other-host?directory=/home")).toBeUndefined()
  })

  test("returns undefined when directory param is missing", () => {
    expect(parseDeepLink("duoduo://open-project")).toBeUndefined()
  })

  test("returns undefined for invalid URL", () => {
    expect(parseDeepLink("not-a-url")).toBeUndefined()
  })

  test("returns undefined for empty string", () => {
    expect(parseDeepLink("")).toBeUndefined()
  })
})

describe("parseNewSessionDeepLink", () => {
  test("parses new-session deep link with directory only", () => {
    expect(parseNewSessionDeepLink("duoduo://new-session?directory=/home/user")).toEqual({ directory: "/home/user" })
  })

  test("parses new-session deep link with directory and prompt", () => {
    expect(parseNewSessionDeepLink("duoduo://new-session?directory=/home/user&prompt=hello")).toEqual({
      directory: "/home/user",
      prompt: "hello",
    })
  })

  test("returns undefined for wrong hostname", () => {
    expect(parseNewSessionDeepLink("duoduo://open-project?directory=/home")).toBeUndefined()
  })

  test("returns undefined when directory is missing", () => {
    expect(parseNewSessionDeepLink("duoduo://new-session?prompt=hello")).toBeUndefined()
  })

  test("returns object without prompt when prompt is empty", () => {
    expect(parseNewSessionDeepLink("duoduo://new-session?directory=/home&prompt=")).toEqual({ directory: "/home" })
  })

  test("returns undefined for non-duoduo URL", () => {
    expect(parseNewSessionDeepLink("https://example.com")).toBeUndefined()
  })
})

describe("collectOpenProjectDeepLinks", () => {
  test("collects valid directories from mixed URLs", () => {
    const result = collectOpenProjectDeepLinks([
      "duoduo://open-project?directory=/a",
      "https://example.com",
      "duoduo://open-project?directory=/b",
    ])
    expect(result).toEqual(["/a", "/b"])
  })

  test("returns empty array for no valid links", () => {
    expect(collectOpenProjectDeepLinks(["https://example.com", "not-a-url"])).toEqual([])
  })

  test("returns empty array for empty input", () => {
    expect(collectOpenProjectDeepLinks([])).toEqual([])
  })
})

describe("collectNewSessionDeepLinks", () => {
  test("collects valid new-session links", () => {
    const result = collectNewSessionDeepLinks([
      "duoduo://new-session?directory=/a&prompt=hello",
      "duoduo://new-session?directory=/b",
    ])
    expect(result).toEqual([{ directory: "/a", prompt: "hello" }, { directory: "/b" }])
  })

  test("filters out invalid links", () => {
    const result = collectNewSessionDeepLinks(["duoduo://new-session?directory=/a", "https://example.com"])
    expect(result).toEqual([{ directory: "/a" }])
  })
})

describe("drainPendingDeepLinks", () => {
  test("drains and clears pending deep links", () => {
    const win = {
      __DUODUO__: {
        deepLinks: ["duoduo://open-project?directory=/test"],
      },
    } as any
    const result = drainPendingDeepLinks(win)
    expect(result).toEqual(["duoduo://open-project?directory=/test"])
    expect(win.__DUODUO__.deepLinks).toEqual([])
  })

  test("returns empty array when no pending links", () => {
    const win = {} as any
    expect(drainPendingDeepLinks(win)).toEqual([])
  })

  test("returns empty array when __DUODUO__ has no deepLinks", () => {
    const win = { __DUODUO__: {} } as any
    expect(drainPendingDeepLinks(win)).toEqual([])
  })
})
