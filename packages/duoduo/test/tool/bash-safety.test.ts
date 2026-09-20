import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { readFileSync } from "fs"
import { classifyCommand, commandTokens, innerPayloadOf, nestedSpatialReason, parse, redirectWriteTargets } from "../../src/tool/bash"

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

// P0-4: nested payload recursion (shell -c / find -exec / xargs). Mirrors the
// walk in BashTool.scanNestedCommands minus the spatial gate (that part is
// pinned by the Rust nested_violation tests + the E2E self-heal scenario).
describe("P0-4 nested payload recursion (capability level)", () => {
  const walk = async (raw: string, depth = 0): Promise<string | undefined> => {
    if (depth > 3) return "nested command payload beyond depth 3"
    const root = await runPromise(parse(raw, false))
    const verdict = classifyCommand(root, raw, false)
    if (verdict.blocked) return verdict.reason
    for (const node of root.descendantsOfType("command")) {
      const tokens = commandTokens(node, false)
      if (tokens.length === 0) continue
      const { name, args, dynamicName } = (() => {
        // resolveName is module-internal; re-derive the name from the first
        // word and pass the rest as args — sufficient for these payloads.
        const words = tokens.map((t) => t.text)
        return { name: words[0] ?? "", args: tokens.slice(1), dynamicName: false }
      })()
      const payload = innerPayloadOf(name, args)
      if (payload === undefined) continue
      const found = await walk(payload, depth + 1)
      if (found) return found
    }
    return undefined
  }

  test("nested -c payload with sudo is blocked", async () => {
    expect(await walk("bash -c 'sudo apt-get install curl'")).toBeDefined()
  })

  test("find -exec sh -c nested destructive is blocked", async () => {
    expect(await walk("find . -type f -exec sh -c 'sudo rm -rf /' \\;")).toBeDefined()
  })

  test("benign nested payload is allowed", async () => {
    expect(await walk("bash -c 'echo hi'")).toBeUndefined()
    expect(await walk("find . -exec grep TODO {} \\;")).toBeUndefined()
  })

  test("innerPayloadOf extracts -c literal payload", () => {
    expect(
      innerPayloadOf("bash", [
        { type: "word", text: "-c" },
        { type: "raw_string", text: "'sudo rm -rf /'" },
      ]),
    ).toBe("sudo rm -rf /")
  })

// H1: the nested spatial gate must enforce the FULL bound — destructive AND
// plain out-of-bounds — matching `bash_safety::nested_walk` (blocked +
// out_of_bounds doors). The gate logic lives in the exported pure function
// `nestedSpatialReason`, which the real `BashTool.scanNestedCommands` calls;
// the walk itself is pinned by the Rust nested_violation tests.
describe("H1 nested spatial gate (nestedSpatialReason)", () => {
  test("destructive out-of-bounds is blocked", () => {
    expect(nestedSpatialReason({ destructive: new Set(["/tmp"]), dirs: new Set() })).toBeDefined()
  })

  test("non-destructive out-of-bounds write target is now blocked (was the bypass)", () => {
    // `bash -c 'echo x > /tmp/leak'`: redirect target lands in scan.dirs —
    // previously only scan.destructive blocked, so Rust's hard block was
    // delegated to TS and executed for real under auto-accept.
    expect(nestedSpatialReason({ destructive: new Set(), dirs: new Set(["/tmp"]) })).toBeDefined()
  })

  test("in-bounds scan passes", () => {
    expect(nestedSpatialReason({ destructive: new Set(), dirs: new Set() })).toBeUndefined()
  })
})

  test("innerPayloadOf ignores dynamic -c payload (blocked by classifier)", () => {
    expect(
      innerPayloadOf("bash", [
        { type: "word", text: "-c" },
        { type: "simple_expansion", text: "$V" },
      ]),
    ).toBeUndefined()
  })
})

// A1: redirect write targets feed the spatial bound — extraction contract.
describe("redirectWriteTargets (A1 spatial bound)", () => {
  const targets = async (command: string, ps = false) => {
    const root = await runPromise(parse(command, ps))
    return redirectWriteTargets(root)
  }

  test("extracts bash output redirect targets (all glued forms)", async () => {
    expect(await targets("echo x > /tmp/f")).toEqual(["/tmp/f"])
    expect(await targets("cmd >> out.txt")).toEqual(["out.txt"])
    expect(await targets("cmd 2>/tmp/err")).toEqual(["/tmp/err"])
    expect(await targets("echo x>/tmp/f")).toEqual(["/tmp/f"])
    expect(await targets("{ echo a; } > group.txt")).toEqual(["group.txt"])
  })

  test("ignores reads, fd dups, and heredocs", async () => {
    expect(await targets("cmd < in.txt")).toEqual([])
    expect(await targets("cmd 2>&1")).toEqual([])
    expect(await targets("cat <<EOF\nbody\nEOF")).toEqual([])
  })

  test("powershell redirection nodes", async () => {
    expect(await targets("echo x > /tmp/f", true)).toEqual(["/tmp/f"])
    expect(await targets("echo x >> /tmp/f", true)).toEqual(["/tmp/f"])
  })
})
