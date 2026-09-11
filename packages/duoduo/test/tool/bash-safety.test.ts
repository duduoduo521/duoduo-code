import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { readFileSync } from "fs"
import { classifyCommand, parse } from "../../src/tool/bash"

// Shared vector file — the SAME file is consumed by the Rust side
// (crates/agent-executor/src/bash_safety.rs shared_vectors_parity test), so
// any rule drift between the two implementations fails in CI on either side.
interface Vector {
  command: string
  ts: "block" | "allow"
  rust: "block" | "allow"
  note?: string
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixture/bash-safety.vectors.json", import.meta.url), "utf8"),
) as { vectors: Vector[] }

// Effect v4 beta: Effect.gen infers R as `unknown`; cast it away.
const runPromise = <A, E>(effect: Effect.Effect<A, E, unknown>): Promise<A> =>
  Effect.runPromise(effect as unknown as Effect.Effect<A, E, never>)

describe("bash-safety shared vectors (TS classifyCommand)", () => {
  test("vector file is non-empty", () => {
    expect(fixture.vectors.length).toBeGreaterThan(0)
  })

  for (const vector of fixture.vectors) {
    const label = vector.ts === "block" ? "blocks" : "allows"
    test(`${label}: ${vector.command}`, async () => {
      const root = await runPromise(parse(vector.command, false))
      const verdict = classifyCommand(root, vector.command, false)
      expect(verdict.blocked).toBe(vector.ts === "block")
    })
  }

  // P5: true dual-side parity. The test above only asserts the TS column
  // against classifyCommand; it never compares the two columns. That let the
  // 9 ts:allow / rust:block divergences sit green on both sides for months.
  // Now every vector must have ts === rust — if the two columns ever drift
  // again, this assertion fails regardless of which implementation changed.
  test("ts and rust verdicts are identical for every vector (dual-side parity)", () => {
    for (const vector of fixture.vectors) {
      expect(vector.ts).toBe(vector.rust)
    }
  })
})
