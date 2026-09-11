import { describe, expect, test } from "bun:test"
import { nextTabListScrollLeft } from "./file-tab-scroll"

describe("nextTabListScrollLeft", () => {
  test("returns undefined when scrollWidth has not increased", () => {
    expect(
      nextTabListScrollLeft({
        prevScrollWidth: 500,
        scrollWidth: 500,
        clientWidth: 300,
        prevContextOpen: false,
        contextOpen: false,
      }),
    ).toBeUndefined()
  })

  test("returns undefined when scrollWidth decreased", () => {
    expect(
      nextTabListScrollLeft({
        prevScrollWidth: 500,
        scrollWidth: 400,
        clientWidth: 300,
        prevContextOpen: false,
        contextOpen: false,
      }),
    ).toBeUndefined()
  })

  test("returns 0 when context just opened", () => {
    expect(
      nextTabListScrollLeft({
        prevScrollWidth: 400,
        scrollWidth: 600,
        clientWidth: 300,
        prevContextOpen: false,
        contextOpen: true,
      }),
    ).toBe(0)
  })

  test("returns undefined when content fits in viewport", () => {
    expect(
      nextTabListScrollLeft({
        prevScrollWidth: 400,
        scrollWidth: 500,
        clientWidth: 500,
        prevContextOpen: false,
        contextOpen: false,
      }),
    ).toBeUndefined()
  })

  test("returns scrollWidth - clientWidth when tabs overflow", () => {
    expect(
      nextTabListScrollLeft({
        prevScrollWidth: 400,
        scrollWidth: 600,
        clientWidth: 300,
        prevContextOpen: false,
        contextOpen: false,
      }),
    ).toBe(300)
  })

  test("returns scrollWidth - clientWidth when context was already open", () => {
    expect(
      nextTabListScrollLeft({
        prevScrollWidth: 400,
        scrollWidth: 600,
        clientWidth: 300,
        prevContextOpen: true,
        contextOpen: true,
      }),
    ).toBe(300)
  })

  test("returns 0 when context opens and content fits", () => {
    expect(
      nextTabListScrollLeft({
        prevScrollWidth: 200,
        scrollWidth: 300,
        clientWidth: 300,
        prevContextOpen: false,
        contextOpen: true,
      }),
    ).toBe(0)
  })
})
