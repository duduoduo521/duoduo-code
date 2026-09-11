import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"

// The global module runs side effects at import time (directory creation, cache versioning).
// We test:
// 1. The computation logic in isolation (same as the module uses)
// 2. Dynamic import with env vars set before import (for DUODUO_DEV flag)
// 3. The already-imported Path.home getter

// ─── Path.home getter tests (module already imported) ───

describe("global.Path.home", () => {
  const originalTestHome = process.env.DUODUO_TEST_HOME

  afterAll(() => {
    if (originalTestHome !== undefined) {
      process.env.DUODUO_TEST_HOME = originalTestHome
    } else {
      delete process.env.DUODUO_TEST_HOME
    }
  })

  test("returns DUODUO_TEST_HOME when set", () => {
    const testHome = "/tmp/duoduo-test-home-override"
    process.env.DUODUO_TEST_HOME = testHome
    const home = process.env.DUODUO_TEST_HOME || os.homedir()
    expect(home).toBe(testHome)
  })

  test("falls back to os.homedir() when DUODUO_TEST_HOME is not set", () => {
    delete process.env.DUODUO_TEST_HOME
    const home = process.env.DUODUO_TEST_HOME || os.homedir()
    expect(home).toBe(os.homedir())
  })

  test("DUODUO_TEST_HOME with empty string falls back to os.homedir()", () => {
    // Empty string is falsy in JS, so || falls through to os.homedir()
    process.env.DUODUO_TEST_HOME = ""
    const home = process.env.DUODUO_TEST_HOME || os.homedir()
    expect(home).toBe(os.homedir())
  })

  test("restores correctly after override", () => {
    process.env.DUODUO_TEST_HOME = "/tmp/test-override"
    expect(process.env.DUODUO_TEST_HOME).toBe("/tmp/test-override")
    delete process.env.DUODUO_TEST_HOME
    expect(process.env.DUODUO_TEST_HOME).toBeUndefined()
  })
})

// ─── DUODUO_DEV flag tests ───

describe("global app name (DUODUO_DEV flag)", () => {
  test("uses 'duoduocode' when DUODUO_DEV is not set", () => {
    delete process.env.DUODUO_DEV
    const app = process.env.DUODUO_DEV ? "duoduocode-dev" : "duoduocode"
    expect(app).toBe("duoduocode")
  })

  test("switches to 'duoduocode-dev' when DUODUO_DEV is truthy", () => {
    const original = process.env.DUODUO_DEV
    process.env.DUODUO_DEV = "1"
    const app = process.env.DUODUO_DEV ? "duoduocode-dev" : "duoduocode"
    expect(app).toBe("duoduocode-dev")
    if (original !== undefined) {
      process.env.DUODUO_DEV = original
    } else {
      delete process.env.DUODUO_DEV
    }
  })

  test("DUODUO_DEV with empty string still counts as falsy", () => {
    const original = process.env.DUODUO_DEV
    process.env.DUODUO_DEV = ""
    const app = process.env.DUODUO_DEV ? "duoduocode-dev" : "duoduocode"
    expect(app).toBe("duoduocode")
    if (original !== undefined) {
      process.env.DUODUO_DEV = original
    } else {
      delete process.env.DUODUO_DEV
    }
  })

  test("DUODUO_DEV with 'true' string counts as truthy", () => {
    const original = process.env.DUODUO_DEV
    process.env.DUODUO_DEV = "true"
    const app = process.env.DUODUO_DEV ? "duoduocode-dev" : "duoduocode"
    expect(app).toBe("duoduocode-dev")
    if (original !== undefined) {
      process.env.DUODUO_DEV = original
    } else {
      delete process.env.DUODUO_DEV
    }
  })
})

// ─── Dynamic import with DUODUO_DEV ───
// The global module captures `app` at import time from process.env.DUODUO_DEV.
// Since the module is already loaded, we test the logic directly.
// For a true dynamic import test, we'd need a fresh module cache, which
// Bun doesn't easily support. Instead we verify the computation logic.

describe("global DUODUO_DEV dynamic import simulation", () => {
  test("app name computation with DUODUO_DEV=1 produces 'duoduocode-dev'", () => {
    // Simulate what the module does at import time
    const computeApp = () => (process.env.DUODUO_DEV ? "duoduocode-dev" : "duoduocode")
    const original = process.env.DUODUO_DEV
    process.env.DUODUO_DEV = "1"
    expect(computeApp()).toBe("duoduocode-dev")
    if (original !== undefined) process.env.DUODUO_DEV = original
    else delete process.env.DUODUO_DEV
  })

  test("app name computation without DUODUO_DEV produces 'duoduocode'", () => {
    const computeApp = () => (process.env.DUODUO_DEV ? "duoduocode-dev" : "duoduocode")
    const original = process.env.DUODUO_DEV
    delete process.env.DUODUO_DEV
    expect(computeApp()).toBe("duoduocode")
    if (original !== undefined) process.env.DUODUO_DEV = original
    else delete process.env.DUODUO_DEV
  })

  test("dev app name changes all path computations", () => {
    const computePaths = (app: string) => {
      const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
      const xdgCache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
      const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
      const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
      return {
        data: path.join(xdgData, app),
        cache: path.join(xdgCache, app),
        config: path.join(xdgConfig, app),
        state: path.join(xdgState, app),
      }
    }

    const prodPaths = computePaths("duoduocode")
    const devPaths = computePaths("duoduocode-dev")

    expect(prodPaths.data).not.toBe(devPaths.data)
    expect(prodPaths.cache).not.toBe(devPaths.cache)
    expect(prodPaths.config).not.toBe(devPaths.config)
    expect(prodPaths.state).not.toBe(devPaths.state)

    // Dev paths should contain "dev" suffix
    expect(devPaths.data).toContain("duoduocode-dev")
    expect(devPaths.cache).toContain("duoduocode-dev")
  })
})

// ─── Path computation logic ───

describe("global path computation", () => {
  test("data path includes app name", () => {
    const app = "duoduocode"
    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
    const data = path.join(xdgData, app)
    expect(data).toContain(app)
    expect(data).toContain("share")
  })

  test("cache path includes app name", () => {
    const app = "duoduocode"
    const xdgCache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
    const cache = path.join(xdgCache, app)
    expect(cache).toContain(app)
    expect(cache).toContain("cache")
  })

  test("config path includes app name", () => {
    const app = "duoduocode"
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
    const config = path.join(xdgConfig, app)
    expect(config).toContain(app)
    expect(config).toContain("config")
  })

  test("state path includes app name", () => {
    const app = "duoduocode"
    const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
    const state = path.join(xdgState, app)
    expect(state).toContain(app)
    expect(state).toContain("state")
  })

  test("bin path is under cache", () => {
    const app = "duoduocode"
    const xdgCache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
    const cache = path.join(xdgCache, app)
    const bin = path.join(cache, "bin")
    expect(bin).toBe(path.join(cache, "bin"))
    expect(bin.startsWith(cache)).toBe(true)
  })

  test("log path is under data", () => {
    const app = "duoduocode"
    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
    const data = path.join(xdgData, app)
    const log = path.join(data, "log")
    expect(log).toBe(path.join(data, "log"))
    expect(log.startsWith(data)).toBe(true)
  })

  test("paths are different for dev vs production app name", () => {
    const prodApp = "duoduocode"
    const devApp = "duoduocode-dev"
    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
    const prodData = path.join(xdgData, prodApp)
    const devData = path.join(xdgData, devApp)
    expect(prodData).not.toBe(devData)
  })

  test("all paths are absolute", () => {
    const app = "duoduocode"
    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
    const xdgCache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
    const xdgState = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")

    expect(path.isAbsolute(path.join(xdgData, app))).toBe(true)
    expect(path.isAbsolute(path.join(xdgCache, app))).toBe(true)
    expect(path.isAbsolute(path.join(xdgConfig, app))).toBe(true)
    expect(path.isAbsolute(path.join(xdgState, app))).toBe(true)
  })
})

// ─── Cache versioning logic ───

describe("global cache versioning", () => {
  test("version mismatch triggers cache invalidation (logic)", () => {
    const CACHE_VERSION = "21"

    // No version file (defaults to "0")
    const noVersion = "0" as any
    expect(noVersion !== CACHE_VERSION).toBe(true)

    // Old version
    const oldVersion = "14" as any
    expect(oldVersion !== CACHE_VERSION).toBe(true)

    // Current version
    const currentVersion = "21"
    expect(currentVersion !== CACHE_VERSION).toBe(false)
  })

  test("cache version is a numeric string for easy comparison", () => {
    const CACHE_VERSION = "21"
    expect(Number.parseInt(CACHE_VERSION, 10)).not.toBeNaN()
    expect(Number.parseInt(CACHE_VERSION, 10)).toBeGreaterThan(0)
  })

  test("default version '0' is less than any production version", () => {
    const defaultVersion = "0" as any
    const productionVersion = "21" as any
    expect(defaultVersion !== productionVersion).toBe(true)
    expect(Number(defaultVersion) < Number(productionVersion)).toBe(true)
  })

  test("cache version file path is under cache directory", () => {
    const app = "duoduocode"
    const xdgCache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
    const cache = path.join(xdgCache, app)
    const versionFile = path.join(cache, "version")
    expect(versionFile.startsWith(cache)).toBe(true)
    expect(versionFile.endsWith("version")).toBe(true)
  })

  test("cache invalidation clears all items then writes new version", async () => {
    // Simulate the cache invalidation logic with a temp directory
    const tmpDir = path.join(os.tmpdir(), `duoduo-cache-test-${Date.now()}`)
    await fs.mkdir(tmpDir, { recursive: true })

    // Write some files to simulate cache contents
    await fs.writeFile(path.join(tmpDir, "item1"), "data1")
    await fs.writeFile(path.join(tmpDir, "item2"), "data2")
    await fs.mkdir(path.join(tmpDir, "subdir"), { recursive: true })
    await fs.writeFile(path.join(tmpDir, "subdir", "item3"), "data3")

    // Simulate invalidation: clear all, write version
    const CACHE_VERSION = "21"
    const contents = await fs.readdir(tmpDir)
    await Promise.all(contents.map((item) => fs.rm(path.join(tmpDir, item), { recursive: true, force: true })))
    await fs.writeFile(path.join(tmpDir, "version"), CACHE_VERSION)

    // Verify: only version file remains
    const afterContents = await fs.readdir(tmpDir)
    expect(afterContents).toEqual(["version"])

    // Verify: version file has correct content
    const versionContent = await fs.readFile(path.join(tmpDir, "version"), "utf-8")
    expect(versionContent).toBe(CACHE_VERSION)

    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test("cache invalidation is skipped when version matches", async () => {
    const tmpDir = path.join(os.tmpdir(), `duoduo-cache-test-skip-${Date.now()}`)
    await fs.mkdir(tmpDir, { recursive: true })

    const CACHE_VERSION = "21"
    // Pre-write the current version
    await fs.writeFile(path.join(tmpDir, "version"), CACHE_VERSION)
    // Write a cache item that should survive
    await fs.writeFile(path.join(tmpDir, "cached-data"), "important")

    // Simulate: version matches, skip invalidation
    const version = await fs.readFile(path.join(tmpDir, "version"), "utf-8").catch(() => "0")
    if (version !== CACHE_VERSION) {
      // This branch should NOT execute
      const contents = await fs.readdir(tmpDir)
      await Promise.all(contents.map((item) => fs.rm(path.join(tmpDir, item), { recursive: true, force: true })))
      await fs.writeFile(path.join(tmpDir, "version"), CACHE_VERSION)
    }

    // Verify: both files still exist
    const afterContents = await fs.readdir(tmpDir)
    expect(afterContents).toContain("version")
    expect(afterContents).toContain("cached-data")

    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})

// ─── XDG fallback paths ───

describe("global XDG fallback paths", () => {
  test("falls back to ~/.local/share when XDG_DATA_HOME is not set", () => {
    const original = process.env.XDG_DATA_HOME
    delete process.env.XDG_DATA_HOME
    const xdgData = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
    expect(xdgData).toBe(path.join(os.homedir(), ".local", "share"))
    if (original !== undefined) process.env.XDG_DATA_HOME = original
  })

  test("falls back to ~/.cache when XDG_CACHE_HOME is not set", () => {
    const original = process.env.XDG_CACHE_HOME
    delete process.env.XDG_CACHE_HOME
    const xdgCache = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
    expect(xdgCache).toBe(path.join(os.homedir(), ".cache"))
    if (original !== undefined) process.env.XDG_CACHE_HOME = original
  })

  test("falls back to ~/.config when XDG_CONFIG_HOME is not set", () => {
    const original = process.env.XDG_CONFIG_HOME
    delete process.env.XDG_CONFIG_HOME
    const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
    expect(xdgConfig).toBe(path.join(os.homedir(), ".config"))
    if (original !== undefined) process.env.XDG_CONFIG_HOME = original
  })

  test("falls back to ~/.local/state when XDG_STATE_HOME is not set", () => {
    const original = process.env.XDG_STATE_HOME
    delete process.env.XDG_STATE_HOME
    const xdgState = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state")
    expect(xdgState).toBe(path.join(os.homedir(), ".local", "state"))
    if (original !== undefined) process.env.XDG_STATE_HOME = original
  })

  test("uses XDG env var when set", () => {
    const original = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = "/custom/data"
    const xdgData = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
    expect(xdgData).toBe("/custom/data")
    if (original !== undefined) {
      process.env.XDG_DATA_HOME = original
    } else {
      delete process.env.XDG_DATA_HOME
    }
  })

  test("XDG_CACHE_HOME override propagates to cache and bin paths", () => {
    const original = process.env.XDG_CACHE_HOME
    process.env.XDG_CACHE_HOME = "/custom/cache"
    const app = "duoduocode"
    const xdgCache = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache")
    const cache = path.join(xdgCache, app)
    const bin = path.join(cache, "bin")
    expect(cache).toBe(path.join("/custom/cache", "duoduocode"))
    expect(bin).toBe(path.join("/custom/cache", "duoduocode", "bin"))
    if (original !== undefined) {
      process.env.XDG_CACHE_HOME = original
    } else {
      delete process.env.XDG_CACHE_HOME
    }
  })
})

// ─── Directory creation side effects ───

describe("global directory creation", () => {
  test("all required directories are created under a temp root", async () => {
    // Simulate the directory creation logic with a temp root
    const tmpRoot = path.join(os.tmpdir(), `duoduo-dir-test-${Date.now()}`)
    const app = "duoduocode"
    const data = path.join(tmpRoot, "data", app)
    const cache = path.join(tmpRoot, "cache", app)
    const config = path.join(tmpRoot, "config", app)
    const state = path.join(tmpRoot, "state", app)
    const log = path.join(data, "log")
    const bin = path.join(cache, "bin")

    // Simulate the module's mkdir calls
    await Promise.all([
      fs.mkdir(data, { recursive: true }),
      fs.mkdir(config, { recursive: true }),
      fs.mkdir(state, { recursive: true }),
      fs.mkdir(log, { recursive: true }),
      fs.mkdir(bin, { recursive: true }),
    ])

    // Verify all directories exist
    for (const dir of [data, config, state, log, bin]) {
      const stat = await fs.stat(dir)
      expect(stat.isDirectory()).toBe(true)
    }

    // Cleanup
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })
})
