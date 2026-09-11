import { describe, expect, it } from "bun:test"
import yargs from "yargs"
import { RunCommand } from "../../../src/cli/cmd/run"

/**
 * Behavioral contract tests for `duoduo run`.
 *
 * These tests lock in CLI-visible behavior that was previously silently broken:
 *   - #4: the dead `--port` option (overridden by network layer) was removed and
 *        must never come back, otherwise it shadows real port handling.
 *
 * Scope note: the exit-code propagation (#1: session error -> exitCode 1) and the
 * 3s idle-timeout warning (#3: exitCode 2) live inside `execute()`, which requires
 * a live server + provider. They are intentionally NOT covered here (would need an
 * integration harness); the source-level guards remain and are documented inline.
 */

function declaredOptions() {
  // RunCommand.builder is a pure function (yargs: Argv) => Argv and does not
  // touch the network or bootstrap, so we can invoke it directly.
  const y = RunCommand.builder(yargs([]) as unknown as Parameters<typeof RunCommand.builder>[0])
  return (y as unknown as { getOptions(): { key: Record<string, boolean> } }).getOptions().key
}

describe("RunCommand option contract", () => {
  const keys = Object.keys(declaredOptions())

  it("#4 regression: dead '--port' option is NOT declared", () => {
    // `--port` was a dead option that shadowed the network layer's real port
    // resolution. Its removal must be locked in.
    expect(keys).not.toContain("port")
  })

  it("core message/session options are declared", () => {
    for (const opt of ["continue", "session", "model", "agent", "attach", "title", "file", "dir", "variant", "thinking", "fork"]) {
      expect(keys, `expected option --${opt} to exist`).toContain(opt)
    }
  })

  it("permission/format options are declared", () => {
    for (const opt of ["format", "dangerously-skip-permissions", "password"]) {
      expect(keys, `expected option --${opt} to exist`).toContain(opt)
    }
  })

  it("aliases are wired (continue -> c, session -> s)", () => {
    // yargs.getOptions().key includes alias names, so presence asserts the alias.
    expect(keys).toContain("c")
    expect(keys).toContain("s")
  })

  it("option types are sane", () => {
    const y = RunCommand.builder(yargs([]) as unknown as Parameters<typeof RunCommand.builder>[0])
    const opts = (y as unknown as { getOptions(): { string: string[]; boolean: string[] } }).getOptions()
    expect(opts.string).toContain("format")
    expect(opts.boolean).toContain("continue")
    expect(opts.boolean).toContain("dangerously-skip-permissions")
  })
})
