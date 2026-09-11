import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { Origin } from "../../src/config/plugin"
import { deduplicatePluginOrigins, load, pluginOptions, pluginSpecifier, resolvePluginSpec } from "../../src/config/plugin"
import { tmpdir } from "../fixture/fixture"

function origin(spec: Origin["spec"], source: string, scope: Origin["scope"] = "global"): Origin {
  return { spec, source, scope }
}

describe("config.plugin.pluginSpecifier", () => {
  test("returns a bare string spec unchanged", () => {
    expect(pluginSpecifier("@duoduo-ai/plugin-foo")).toBe("@duoduo-ai/plugin-foo")
  })

  test("unwraps the identifier from a [spec, options] tuple", () => {
    expect(pluginSpecifier(["@duoduo-ai/plugin-foo", { level: 3 }])).toBe("@duoduo-ai/plugin-foo")
  })
})

describe("config.plugin.pluginOptions", () => {
  test("returns undefined for a bare string spec", () => {
    expect(pluginOptions("@duoduo-ai/plugin-foo")).toBeUndefined()
  })

  test("returns the inline options of a tuple spec", () => {
    expect(pluginOptions(["@duoduo-ai/plugin-foo", { level: 3 }])).toEqual({ level: 3 })
  })
})

describe("config.plugin.resolvePluginSpec", () => {
  test("leaves a non-path spec untouched", async () => {
    await expect(resolvePluginSpec("@duoduo-ai/plugin-foo", path.join(process.cwd(), "config.json"))).resolves.toBe(
      "@duoduo-ai/plugin-foo",
    )
  })

  test("resolves a relative path against the directory of the declaring config file", async () => {
    const config = path.join(process.cwd(), "nested", "config.json")
    const out = await resolvePluginSpec("./plugin.ts", config)
    expect(out).toBe(pathToFileURL(path.resolve(process.cwd(), "nested", "plugin.ts")).href)
  })

  test("keeps the inline options when resolving a tuple spec", async () => {
    const config = path.join(process.cwd(), "config.json")
    const out = await resolvePluginSpec(["./plugin.ts", { level: 3 }], config)
    expect(out).toEqual([pathToFileURL(path.resolve(process.cwd(), "plugin.ts")).href, { level: 3 }])
  })

  test("keeps an absolute path as a file:// URL", async () => {
    const absolute = path.join(process.cwd(), "abs-plugin.ts")
    const out = await resolvePluginSpec(absolute, path.join(process.cwd(), "config.json"))
    expect(out).toBe(pathToFileURL(absolute).href)
  })

  test("keeps an already-resolved file:// spec unchanged", async () => {
    const spec = pathToFileURL(path.join(process.cwd(), "already.ts")).href
    await expect(resolvePluginSpec(spec, path.join(process.cwd(), "config.json"))).resolves.toBe(spec)
  })
})

describe("config.plugin.deduplicatePluginOrigins", () => {
  test("keeps the last declaration and preserves the original order of the survivors", () => {
    const list = [
      origin("@scope/a", "global.json"),
      origin("@scope/pkg", "global.json"),
      origin("@scope/pkg", "local.json", "local"),
    ]
    expect(deduplicatePluginOrigins(list)).toEqual([
      origin("@scope/a", "global.json"),
      origin("@scope/pkg", "local.json", "local"),
    ])
  })

  test("dedupes npm specs by package name, ignoring the version", () => {
    const list = [origin("@scope/pkg@1.0.0", "global.json"), origin("@scope/pkg@2.0.0", "local.json", "local")]
    expect(deduplicatePluginOrigins(list)).toEqual([origin("@scope/pkg@2.0.0", "local.json", "local")])
  })

  test("dedupes file specs by exact URL", () => {
    const url = pathToFileURL(path.join(process.cwd(), "plugin.ts")).href
    expect(deduplicatePluginOrigins([origin(url, "global.json"), origin(url, "local.json", "local")])).toEqual([
      origin(url, "local.json", "local"),
    ])
  })

  test("keeps two different file specs separate", () => {
    const a = pathToFileURL(path.join(process.cwd(), "a.ts")).href
    const b = pathToFileURL(path.join(process.cwd(), "b.ts")).href
    expect(deduplicatePluginOrigins([origin(a, "global.json"), origin(b, "global.json")])).toEqual([
      origin(a, "global.json"),
      origin(b, "global.json"),
    ])
  })

  test("returns an empty list for empty input", () => {
    expect(deduplicatePluginOrigins([])).toEqual([])
  })
})

describe("config.plugin.load", () => {
  test("collects plugin/plugin files from both `plugin/` and `plugins/` as file URLs", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "plugin"))
    await fs.mkdir(path.join(tmp.path, "plugins"))
    await fs.writeFile(path.join(tmp.path, "plugin", "a.ts"), "export default {}")
    await fs.writeFile(path.join(tmp.path, "plugins", "b.js"), "module.exports = {}")
    // Not a plugin entry point — must be ignored.
    await fs.writeFile(path.join(tmp.path, "plugin", "notes.md"), "nope")
    await fs.writeFile(path.join(tmp.path, "c.ts"), "export default {}")

    const found = await load(tmp.path)
    expect(found.sort()).toEqual(
      [
        pathToFileURL(path.join(tmp.path, "plugin", "a.ts")).href,
        pathToFileURL(path.join(tmp.path, "plugins", "b.js")).href,
      ].sort(),
    )
  })

  test("returns an empty list when no plugin directory exists", async () => {
    await using tmp = await tmpdir()
    expect(await load(tmp.path)).toEqual([])
  })
})
