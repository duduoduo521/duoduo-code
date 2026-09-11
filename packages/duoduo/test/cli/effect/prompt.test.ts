import { describe, expect, test } from "bun:test"
import * as Prompt from "../../../src/cli/effect/prompt"

describe("cli.effect.prompt", () => {
  test("intro returns an Effect", () => {
    const effect = Prompt.intro("test")
    expect(typeof effect).toBe("object")
    // Effect objects have a pipe method
    expect(typeof effect.pipe).toBe("function")
  })

  test("outro returns an Effect", () => {
    const effect = Prompt.outro("done")
    expect(typeof effect).toBe("object")
  })

  test("log.info returns an Effect", () => {
    const effect = Prompt.log.info("message")
    expect(typeof effect).toBe("object")
  })

  test("select returns an Effect", () => {
    const effect = Prompt.select({
      message: "Choose",
      options: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
    })
    expect(typeof effect).toBe("object")
  })

  test("spinner returns object with start and stop Effects", () => {
    const s = Prompt.spinner()
    expect(typeof s.start).toBe("function")
    expect(typeof s.stop).toBe("function")
    const startEffect = s.start("loading...")
    expect(typeof startEffect).toBe("object")
    const stopEffect = s.stop("done")
    expect(typeof stopEffect).toBe("object")
  })
})
