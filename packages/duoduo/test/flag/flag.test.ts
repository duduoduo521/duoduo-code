import { describe, test, expect, beforeEach, afterEach } from "bun:test"

/**
 * Flag module: most values are computed at module load time from process.env.
 * Getter-based flags (DUODUO_DISABLE_PROJECT_CONFIG, DUODUO_PURE, DUODUO_CLIENT,
 * DUODUO_TUI_CONFIG, DUODUO_CONFIG_DIR, DUODUO_PLUGIN_META_FILE) re-evaluate
 * at access time.
 *
 * Strategy:
 * - For getter-based flags: set env at runtime and access the property
 * - For load-time flags: use dynamic import with cache busting to get fresh module
 */

describe("Flag", () => {
  describe("getter-based flags (re-evaluate at access time)", () => {
    let savedEnv: Record<string, string | undefined> = {}

    beforeEach(() => {
      const keys = [
        "DUODUO_DISABLE_PROJECT_CONFIG",
        "DUODUO_PURE",
        "DUODUO_CLIENT",
        "DUODUO_TUI_CONFIG",
        "DUODUO_CONFIG_DIR",
        "DUODUO_PLUGIN_META_FILE",
      ]
      for (const key of keys) {
        savedEnv[key] = process.env[key]
        delete process.env[key]
      }
    })

    afterEach(() => {
      for (const [key, val] of Object.entries(savedEnv)) {
        if (val !== undefined) {
          process.env[key] = val
        } else {
          delete process.env[key]
        }
      }
    })

    async function importFlag() {
      const mod = await import(`../../src/flag/flag.ts?_t=${Date.now()}-${Math.random()}`)
      return mod.Flag
    }

    test("DUODUO_DISABLE_PROJECT_CONFIG: returns true when set to 'true'", async () => {
      process.env.DUODUO_DISABLE_PROJECT_CONFIG = "true"
      const Flag = await importFlag()
      expect(Flag.DUODUO_DISABLE_PROJECT_CONFIG).toBe(true)
    })

    test("DUODUO_DISABLE_PROJECT_CONFIG: returns true when set to '1'", async () => {
      process.env.DUODUO_DISABLE_PROJECT_CONFIG = "1"
      const Flag = await importFlag()
      expect(Flag.DUODUO_DISABLE_PROJECT_CONFIG).toBe(true)
    })

    test("DUODUO_DISABLE_PROJECT_CONFIG: returns false when not set", async () => {
      const Flag = await importFlag()
      expect(Flag.DUODUO_DISABLE_PROJECT_CONFIG).toBe(false)
    })

    test("DUODUO_DISABLE_PROJECT_CONFIG: returns false when set to 'false'", async () => {
      process.env.DUODUO_DISABLE_PROJECT_CONFIG = "false"
      const Flag = await importFlag()
      expect(Flag.DUODUO_DISABLE_PROJECT_CONFIG).toBe(false)
    })

    test("DUODUO_PURE: returns true when set to 'true'", async () => {
      process.env.DUODUO_PURE = "true"
      const Flag = await importFlag()
      expect(Flag.DUODUO_PURE).toBe(true)
    })

    test("DUODUO_PURE: returns false when not set", async () => {
      const Flag = await importFlag()
      expect(Flag.DUODUO_PURE).toBe(false)
    })

    test("DUODUO_PURE: returns true when set to '1'", async () => {
      process.env.DUODUO_PURE = "1"
      const Flag = await importFlag()
      expect(Flag.DUODUO_PURE).toBe(true)
    })

    test("DUODUO_CLIENT: returns env value when set", async () => {
      process.env.DUODUO_CLIENT = "vscode"
      const Flag = await importFlag()
      expect(Flag.DUODUO_CLIENT).toBe("vscode")
    })

    test("DUODUO_CLIENT: defaults to 'cli' when not set", async () => {
      const Flag = await importFlag()
      expect(Flag.DUODUO_CLIENT).toBe("cli")
    })

    test("DUODUO_TUI_CONFIG: returns env value when set", async () => {
      process.env.DUODUO_TUI_CONFIG = "/path/to/tui.json"
      const Flag = await importFlag()
      expect(Flag.DUODUO_TUI_CONFIG).toBe("/path/to/tui.json")
    })

    test("DUODUO_TUI_CONFIG: returns undefined when not set", async () => {
      const Flag = await importFlag()
      expect(Flag.DUODUO_TUI_CONFIG).toBeUndefined()
    })

    test("DUODUO_CONFIG_DIR: returns env value when set", async () => {
      process.env.DUODUO_CONFIG_DIR = "/custom/config"
      const Flag = await importFlag()
      expect(Flag.DUODUO_CONFIG_DIR).toBe("/custom/config")
    })

    test("DUODUO_CONFIG_DIR: returns undefined when not set", async () => {
      const Flag = await importFlag()
      expect(Flag.DUODUO_CONFIG_DIR).toBeUndefined()
    })

    test("DUODUO_PLUGIN_META_FILE: returns env value when set", async () => {
      process.env.DUODUO_PLUGIN_META_FILE = "/path/to/meta.json"
      const Flag = await importFlag()
      expect(Flag.DUODUO_PLUGIN_META_FILE).toBe("/path/to/meta.json")
    })

    test("DUODUO_PLUGIN_META_FILE: returns undefined when not set", async () => {
      const Flag = await importFlag()
      expect(Flag.DUODUO_PLUGIN_META_FILE).toBeUndefined()
    })
  })

  describe("load-time flags (computed at module load)", () => {
    async function importFlag() {
      const mod = await import(`../../src/flag/flag.ts?_t=${Date.now()}-${Math.random()}`)
      return mod.Flag
    }

    test("DUODUO_DISABLE_CLAUDE_CODE: true when env is 'true'", async () => {
      const prev = process.env.DUODUO_DISABLE_CLAUDE_CODE
      process.env.DUODUO_DISABLE_CLAUDE_CODE = "true"
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_DISABLE_CLAUDE_CODE).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.DUODUO_DISABLE_CLAUDE_CODE
        else process.env.DUODUO_DISABLE_CLAUDE_CODE = prev
      }
    })

    test("DUODUO_DISABLE_CLAUDE_CODE: true when env is '1'", async () => {
      const prev = process.env.DUODUO_DISABLE_CLAUDE_CODE
      process.env.DUODUO_DISABLE_CLAUDE_CODE = "1"
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_DISABLE_CLAUDE_CODE).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.DUODUO_DISABLE_CLAUDE_CODE
        else process.env.DUODUO_DISABLE_CLAUDE_CODE = prev
      }
    })

    test("DUODUO_DISABLE_CLAUDE_CODE: false when env is not set", async () => {
      delete process.env.DUODUO_DISABLE_CLAUDE_CODE
      const Flag = await importFlag()
      expect(Flag.DUODUO_DISABLE_CLAUDE_CODE).toBe(false)
    })

    test("DUODUO_DISABLE_CLAUDE_CODE implies DUODUO_DISABLE_CLAUDE_CODE_SKILLS", async () => {
      const prev = process.env.DUODUO_DISABLE_CLAUDE_CODE
      const prevSkills = process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS
      process.env.DUODUO_DISABLE_CLAUDE_CODE = "true"
      delete process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_DISABLE_CLAUDE_CODE_SKILLS).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.DUODUO_DISABLE_CLAUDE_CODE
        else process.env.DUODUO_DISABLE_CLAUDE_CODE = prev
        if (prevSkills === undefined) delete process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS
        else process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS = prevSkills
      }
    })

    test("DUODUO_DISABLE_CLAUDE_CODE implies DUODUO_DISABLE_CLAUDE_CODE_PROMPT", async () => {
      const prev = process.env.DUODUO_DISABLE_CLAUDE_CODE
      const prevPrompt = process.env.DUODUO_DISABLE_CLAUDE_CODE_PROMPT
      process.env.DUODUO_DISABLE_CLAUDE_CODE = "true"
      delete process.env.DUODUO_DISABLE_CLAUDE_CODE_PROMPT
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_DISABLE_CLAUDE_CODE_PROMPT).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.DUODUO_DISABLE_CLAUDE_CODE
        else process.env.DUODUO_DISABLE_CLAUDE_CODE = prev
        if (prevPrompt === undefined) delete process.env.DUODUO_DISABLE_CLAUDE_CODE_PROMPT
        else process.env.DUODUO_DISABLE_CLAUDE_CODE_PROMPT = prevPrompt
      }
    })

    test("DUODUO_DISABLE_CLAUDE_CODE_SKILLS can be set independently", async () => {
      const prev = process.env.DUODUO_DISABLE_CLAUDE_CODE
      const prevSkills = process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS
      delete process.env.DUODUO_DISABLE_CLAUDE_CODE
      process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS = "true"
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_DISABLE_CLAUDE_CODE).toBe(false)
        expect(Flag.DUODUO_DISABLE_CLAUDE_CODE_SKILLS).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.DUODUO_DISABLE_CLAUDE_CODE
        else process.env.DUODUO_DISABLE_CLAUDE_CODE = prev
        if (prevSkills === undefined) delete process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS
        else process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS = prevSkills
      }
    })

    test("DUODUO_DISABLE_EXTERNAL_SKILLS: true when DUODUO_DISABLE_CLAUDE_CODE_SKILLS is true", async () => {
      const prevSkills = process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS
      const prev = process.env.DUODUO_DISABLE_CLAUDE_CODE
      const prevExternal = process.env.DUODUO_DISABLE_EXTERNAL_SKILLS
      process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS = "true"
      delete process.env.DUODUO_DISABLE_CLAUDE_CODE
      delete process.env.DUODUO_DISABLE_EXTERNAL_SKILLS
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_DISABLE_EXTERNAL_SKILLS).toBe(true)
      } finally {
        if (prevSkills === undefined) delete process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS
        else process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS = prevSkills
        if (prev === undefined) delete process.env.DUODUO_DISABLE_CLAUDE_CODE
        else process.env.DUODUO_DISABLE_CLAUDE_CODE = prev
        if (prevExternal === undefined) delete process.env.DUODUO_DISABLE_EXTERNAL_SKILLS
        else process.env.DUODUO_DISABLE_EXTERNAL_SKILLS = prevExternal
      }
    })

    test("DUODUO_USE_STRUCTURED_CONTEXT is always true", async () => {
      const Flag = await importFlag()
      expect(Flag.DUODUO_USE_STRUCTURED_CONTEXT).toBe(true)
    })

    test("falsy values: 'false' is falsy", async () => {
      const prev = process.env.DUODUO_EXPERIMENTAL_MARKDOWN
      process.env.DUODUO_EXPERIMENTAL_MARKDOWN = "false"
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_EXPERIMENTAL_MARKDOWN).toBe(false)
      } finally {
        if (prev === undefined) delete process.env.DUODUO_EXPERIMENTAL_MARKDOWN
        else process.env.DUODUO_EXPERIMENTAL_MARKDOWN = prev
      }
    })

    test("falsy values: '0' is falsy", async () => {
      const prev = process.env.DUODUO_EXPERIMENTAL_MARKDOWN
      process.env.DUODUO_EXPERIMENTAL_MARKDOWN = "0"
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_EXPERIMENTAL_MARKDOWN).toBe(false)
      } finally {
        if (prev === undefined) delete process.env.DUODUO_EXPERIMENTAL_MARKDOWN
        else process.env.DUODUO_EXPERIMENTAL_MARKDOWN = prev
      }
    })

    test("DUODUO_EXPERIMENTAL_MARKDOWN defaults to true when env not set", async () => {
      delete process.env.DUODUO_EXPERIMENTAL_MARKDOWN
      const Flag = await importFlag()
      expect(Flag.DUODUO_EXPERIMENTAL_MARKDOWN).toBe(true)
    })

    test("number(): returns positive integer for valid env", async () => {
      const prev = process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS
      process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = "30000"
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS).toBe(30000)
      } finally {
        if (prev === undefined) delete process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS
        else process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = prev
      }
    })

    test("number(): returns undefined for non-integer", async () => {
      const prev = process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS
      process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = "3.5"
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS).toBeUndefined()
      } finally {
        if (prev === undefined) delete process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS
        else process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = prev
      }
    })

    test("number(): returns undefined for zero", async () => {
      const prev = process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS
      process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = "0"
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS).toBeUndefined()
      } finally {
        if (prev === undefined) delete process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS
        else process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = prev
      }
    })

    test("number(): returns undefined for negative number", async () => {
      const prev = process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS
      process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = "-5"
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS).toBeUndefined()
      } finally {
        if (prev === undefined) delete process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS
        else process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS = prev
      }
    })

    test("number(): returns undefined when not set", async () => {
      delete process.env.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS
      const Flag = await importFlag()
      expect(Flag.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS).toBeUndefined()
    })

    test("DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT: defaults to true on win32 when env not set", async () => {
      delete process.env.DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
      const Flag = await importFlag()
      // This test is platform-dependent: on win32 it should be true, on others false
      if (process.platform === "win32") {
        expect(Flag.DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT).toBe(true)
      } else {
        expect(Flag.DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT).toBe(false)
      }
    })

    test("DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT: respects env when set", async () => {
      const prev = process.env.DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
      process.env.DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT = "true"
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
        else process.env.DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT = prev
      }
    })

    test("DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT: false when set to 'false'", async () => {
      const prev = process.env.DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
      process.env.DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT = "false"
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT).toBe(false)
      } finally {
        if (prev === undefined) delete process.env.DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
        else process.env.DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT = prev
      }
    })

    test("DUODUO_EXPERIMENTAL: true when env is 'true'", async () => {
      const prev = process.env.DUODUO_EXPERIMENTAL
      process.env.DUODUO_EXPERIMENTAL = "true"
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_EXPERIMENTAL).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.DUODUO_EXPERIMENTAL
        else process.env.DUODUO_EXPERIMENTAL = prev
      }
    })

    test("DUODUO_EXPERIMENTAL implies related flags", async () => {
      const prev = process.env.DUODUO_EXPERIMENTAL
      const prevFilewatcher = process.env.DUODUO_EXPERIMENTAL_FILEWATCHER
      const prevIcon = process.env.DUODUO_EXPERIMENTAL_ICON_DISCOVERY
      const prevOxfmt = process.env.DUODUO_EXPERIMENTAL_OXFMT
      const prevLsp = process.env.DUODUO_EXPERIMENTAL_LSP_TOOL
      const prevPlan = process.env.DUODUO_EXPERIMENTAL_PLAN_MODE
      const prevWorkspaces = process.env.DUODUO_EXPERIMENTAL_WORKSPACES
      process.env.DUODUO_EXPERIMENTAL = "true"
      delete process.env.DUODUO_EXPERIMENTAL_FILEWATCHER
      delete process.env.DUODUO_EXPERIMENTAL_ICON_DISCOVERY
      delete process.env.DUODUO_EXPERIMENTAL_OXFMT
      delete process.env.DUODUO_EXPERIMENTAL_LSP_TOOL
      delete process.env.DUODUO_EXPERIMENTAL_PLAN_MODE
      delete process.env.DUODUO_EXPERIMENTAL_WORKSPACES
      try {
        const Flag = await importFlag()
        // DUODUO_EXPERIMENTAL being true should imply these flags
        expect(Flag.DUODUO_EXPERIMENTAL_ICON_DISCOVERY).toBe(true)
        expect(Flag.DUODUO_EXPERIMENTAL_OXFMT).toBe(true)
        expect(Flag.DUODUO_EXPERIMENTAL_LSP_TOOL).toBe(true)
        expect(Flag.DUODUO_EXPERIMENTAL_PLAN_MODE).toBe(true)
        expect(Flag.DUODUO_EXPERIMENTAL_WORKSPACES).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.DUODUO_EXPERIMENTAL
        else process.env.DUODUO_EXPERIMENTAL = prev
        if (prevFilewatcher === undefined) delete process.env.DUODUO_EXPERIMENTAL_FILEWATCHER
        else process.env.DUODUO_EXPERIMENTAL_FILEWATCHER = prevFilewatcher
        if (prevIcon === undefined) delete process.env.DUODUO_EXPERIMENTAL_ICON_DISCOVERY
        else process.env.DUODUO_EXPERIMENTAL_ICON_DISCOVERY = prevIcon
        if (prevOxfmt === undefined) delete process.env.DUODUO_EXPERIMENTAL_OXFMT
        else process.env.DUODUO_EXPERIMENTAL_OXFMT = prevOxfmt
        if (prevLsp === undefined) delete process.env.DUODUO_EXPERIMENTAL_LSP_TOOL
        else process.env.DUODUO_EXPERIMENTAL_LSP_TOOL = prevLsp
        if (prevPlan === undefined) delete process.env.DUODUO_EXPERIMENTAL_PLAN_MODE
        else process.env.DUODUO_EXPERIMENTAL_PLAN_MODE = prevPlan
        if (prevWorkspaces === undefined) delete process.env.DUODUO_EXPERIMENTAL_WORKSPACES
        else process.env.DUODUO_EXPERIMENTAL_WORKSPACES = prevWorkspaces
      }
    })

    test("string env vars: pass through raw values", async () => {
      const prevBashPath = process.env.DUODUO_GIT_BASH_PATH
      const prevConfig = process.env.DUODUO_CONFIG
      const prevDb = process.env.DUODUO_DB
      process.env.DUODUO_GIT_BASH_PATH = "/usr/bin/bash"
      process.env.DUODUO_CONFIG = "/path/to/config"
      process.env.DUODUO_DB = "/path/to/db"
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_GIT_BASH_PATH).toBe("/usr/bin/bash")
        expect(Flag.DUODUO_CONFIG).toBe("/path/to/config")
        expect(Flag.DUODUO_DB).toBe("/path/to/db")
      } finally {
        if (prevBashPath === undefined) delete process.env.DUODUO_GIT_BASH_PATH
        else process.env.DUODUO_GIT_BASH_PATH = prevBashPath
        if (prevConfig === undefined) delete process.env.DUODUO_CONFIG
        else process.env.DUODUO_CONFIG = prevConfig
        if (prevDb === undefined) delete process.env.DUODUO_DB
        else process.env.DUODUO_DB = prevDb
      }
    })

    test("string env vars: undefined when not set", async () => {
      delete process.env.DUODUO_GIT_BASH_PATH
      delete process.env.DUODUO_CONFIG
      delete process.env.DUODUO_DB
      const Flag = await importFlag()
      expect(Flag.DUODUO_GIT_BASH_PATH).toBeUndefined()
      expect(Flag.DUODUO_CONFIG).toBeUndefined()
      expect(Flag.DUODUO_DB).toBeUndefined()
    })

    test("DUODUO_SERVER_PASSWORD: returns env value", async () => {
      const prev = process.env.DUODUO_SERVER_PASSWORD
      process.env.DUODUO_SERVER_PASSWORD = "secret123"
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_SERVER_PASSWORD).toBe("secret123")
      } finally {
        if (prev === undefined) delete process.env.DUODUO_SERVER_PASSWORD
        else process.env.DUODUO_SERVER_PASSWORD = prev
      }
    })

    test("DUODUO_PERMISSION: returns env value", async () => {
      const prev = process.env.DUODUO_PERMISSION
      process.env.DUODUO_PERMISSION = "ask"
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_PERMISSION).toBe("ask")
      } finally {
        if (prev === undefined) delete process.env.DUODUO_PERMISSION
        else process.env.DUODUO_PERMISSION = prev
      }
    })
  })

  describe("conditional chains", () => {
    async function importFlag() {
      const mod = await import(`../../src/flag/flag.ts?_t=${Date.now()}-${Math.random()}`)
      return mod.Flag
    }

    test("DUODUO_DISABLE_CLAUDE_CODE → DISABLE_CLAUDE_CODE_SKILLS → DISABLE_EXTERNAL_SKILLS chain", async () => {
      const prev = process.env.DUODUO_DISABLE_CLAUDE_CODE
      const prevSkills = process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS
      const prevExternal = process.env.DUODUO_DISABLE_EXTERNAL_SKILLS
      process.env.DUODUO_DISABLE_CLAUDE_CODE = "true"
      delete process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS
      delete process.env.DUODUO_DISABLE_EXTERNAL_SKILLS
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_DISABLE_CLAUDE_CODE).toBe(true)
        expect(Flag.DUODUO_DISABLE_CLAUDE_CODE_SKILLS).toBe(true)
        expect(Flag.DUODUO_DISABLE_EXTERNAL_SKILLS).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.DUODUO_DISABLE_CLAUDE_CODE
        else process.env.DUODUO_DISABLE_CLAUDE_CODE = prev
        if (prevSkills === undefined) delete process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS
        else process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS = prevSkills
        if (prevExternal === undefined) delete process.env.DUODUO_DISABLE_EXTERNAL_SKILLS
        else process.env.DUODUO_DISABLE_EXTERNAL_SKILLS = prevExternal
      }
    })

    test("all three flags can be set independently", async () => {
      const prev = process.env.DUODUO_DISABLE_CLAUDE_CODE
      const prevSkills = process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS
      const prevExternal = process.env.DUODUO_DISABLE_EXTERNAL_SKILLS
      delete process.env.DUODUO_DISABLE_CLAUDE_CODE
      delete process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS
      process.env.DUODUO_DISABLE_EXTERNAL_SKILLS = "true"
      try {
        const Flag = await importFlag()
        expect(Flag.DUODUO_DISABLE_CLAUDE_CODE).toBe(false)
        expect(Flag.DUODUO_DISABLE_CLAUDE_CODE_SKILLS).toBe(false)
        expect(Flag.DUODUO_DISABLE_EXTERNAL_SKILLS).toBe(true)
      } finally {
        if (prev === undefined) delete process.env.DUODUO_DISABLE_CLAUDE_CODE
        else process.env.DUODUO_DISABLE_CLAUDE_CODE = prev
        if (prevSkills === undefined) delete process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS
        else process.env.DUODUO_DISABLE_CLAUDE_CODE_SKILLS = prevSkills
        if (prevExternal === undefined) delete process.env.DUODUO_DISABLE_EXTERNAL_SKILLS
        else process.env.DUODUO_DISABLE_EXTERNAL_SKILLS = prevExternal
      }
    })
  })
})
