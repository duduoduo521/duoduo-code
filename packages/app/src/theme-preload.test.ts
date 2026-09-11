import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/theme-preload.js", import.meta.url)).text()

// oxlint-disable-next-line no-implied-eval -- intentional: execute preload script source string in test
const run = () => Function(src)()

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: false,
      }) as MediaQueryList,
    configurable: true,
  })
})

describe("theme preload", () => {
  test("migrates a removed theme id to the default before mount", () => {
    localStorage.setItem("duoduo-theme-id", "tokyonight")
    localStorage.setItem("duoduo-theme-css-light", "--background-base:#fff;")
    localStorage.setItem("duoduo-theme-css-dark", "--background-base:#000;")

    run()

    expect(document.documentElement.dataset.theme).toBe("dawn")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(localStorage.getItem("duoduo-theme-id")).toBe("dawn")
    expect(localStorage.getItem("duoduo-theme-css-light")).toBeNull()
    expect(localStorage.getItem("duoduo-theme-css-dark")).toBeNull()
    expect(document.getElementById("duoduo-theme-preload")).toBeNull()
  })

  test("keeps cached css for non-default themes", () => {
    localStorage.setItem("duoduo-theme-id", "cinnabar")
    localStorage.setItem("duoduo-theme-css-light", "--background-base:#fff;")

    run()

    expect(document.documentElement.dataset.theme).toBe("cinnabar")
    expect(document.getElementById("duoduo-theme-preload")?.textContent).toContain("--background-base:#fff;")
  })
})
