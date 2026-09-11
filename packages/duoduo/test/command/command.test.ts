import { describe, expect, test } from "bun:test"
import { hints } from "../../src/command"

describe("hints", () => {
  test("returns empty array for empty string", () => {
    expect(hints("")).toEqual([])
  })

  test("returns empty array for string with no placeholders", () => {
    expect(hints("Hello world")).toEqual([])
  })

  test("extracts single numbered param", () => {
    expect(hints("Hello $1")).toEqual(["$1"])
  })

  test("extracts multiple numbered params", () => {
    expect(hints("$1 and $2")).toEqual(["$1", "$2"])
  })

  test("deduplicates numbered params", () => {
    expect(hints("$1 and $1 again")).toEqual(["$1"])
  })

  test("sorts unsorted numbered params", () => {
    expect(hints("$3 and $1")).toEqual(["$1", "$3"])
  })

  test("extracts $ARGUMENTS only", () => {
    expect(hints("Do $ARGUMENTS")).toEqual(["$ARGUMENTS"])
  })

  test("extracts mixed numbered params and $ARGUMENTS", () => {
    expect(hints("$1 with $ARGUMENTS and $2")).toEqual(["$1", "$2", "$ARGUMENTS"])
  })

  test("matches $0 as a numbered param (\\d+ includes 0)", () => {
    expect(hints("$0")).toEqual(["$0"])
  })

  test("matches multi-digit numbered param $10", () => {
    expect(hints("$10")).toEqual(["$10"])
  })

  test("$ARGUMENTS does not match /\\$\\d+/g", () => {
    // $ARGUMENTS is handled by the separate .includes() check, not the regex
    const result = hints("$ARGUMENTS")
    expect(result).toEqual(["$ARGUMENTS"])
    // Verify the regex alone does not match $ARGUMENTS
    expect("$ARGUMENTS".match(/\$\d+/g)).toBeNull()
  })

  test("deduplicates and sorts with $ARGUMENTS appended last", () => {
    expect(hints("$2 and $1 and $2 with $ARGUMENTS and $ARGUMENTS")).toEqual(["$1", "$2", "$ARGUMENTS"])
  })

  test("handles template with only text and no dollar signs", () => {
    expect(hints("plain text without placeholders")).toEqual([])
  })

  test("handles numbered params with gaps", () => {
    expect(hints("$1 and $5 and $10")).toEqual(["$1", "$10", "$5"])
  })

  test("does not match $ARGUMENTS_PARTIAL", () => {
    // $ARGUMENTS must be exact — $ARGUMENTS_PARTIAL should not trigger the includes check
    expect(hints("$ARGUMENTS_PARTIAL")).toEqual([])
  })

  test("handles template with adjacent placeholders", () => {
    expect(hints("$1$2")).toEqual(["$1", "$2"])
  })

  test("handles template with $ARGUMENTS appearing multiple times", () => {
    // $ARGUMENTS is only pushed once since includes is a boolean check
    expect(hints("$ARGUMENTS then $ARGUMENTS")).toEqual(["$ARGUMENTS"])
  })
})
