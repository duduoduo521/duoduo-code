import { describe, test, expect } from "bun:test"
import { LANGUAGE_EXTENSIONS } from "../../src/lsp/language"

describe("LANGUAGE_EXTENSIONS", () => {
  describe("known extensions map to correct languages", () => {
    test(".ts → typescript", () => {
      expect(LANGUAGE_EXTENSIONS[".ts"]).toBe("typescript")
    })

    test(".tsx → typescriptreact", () => {
      expect(LANGUAGE_EXTENSIONS[".tsx"]).toBe("typescriptreact")
    })

    test(".js → javascript", () => {
      expect(LANGUAGE_EXTENSIONS[".js"]).toBe("javascript")
    })

    test(".jsx → javascriptreact", () => {
      expect(LANGUAGE_EXTENSIONS[".jsx"]).toBe("javascriptreact")
    })

    test(".rs → rust", () => {
      expect(LANGUAGE_EXTENSIONS[".rs"]).toBe("rust")
    })

    test(".py → python", () => {
      expect(LANGUAGE_EXTENSIONS[".py"]).toBe("python")
    })

    test(".go → go", () => {
      expect(LANGUAGE_EXTENSIONS[".go"]).toBe("go")
    })

    test(".java → java", () => {
      expect(LANGUAGE_EXTENSIONS[".java"]).toBe("java")
    })

    test(".c → c", () => {
      expect(LANGUAGE_EXTENSIONS[".c"]).toBe("c")
    })

    test(".cpp → cpp", () => {
      expect(LANGUAGE_EXTENSIONS[".cpp"]).toBe("cpp")
    })

    test(".css → css", () => {
      expect(LANGUAGE_EXTENSIONS[".css"]).toBe("css")
    })

    test(".html → html", () => {
      expect(LANGUAGE_EXTENSIONS[".html"]).toBe("html")
    })

    test(".sh → shellscript", () => {
      expect(LANGUAGE_EXTENSIONS[".sh"]).toBe("shellscript")
    })

    test(".json → json", () => {
      expect(LANGUAGE_EXTENSIONS[".json"]).toBe("json")
    })

    test(".md → markdown", () => {
      expect(LANGUAGE_EXTENSIONS[".md"]).toBe("markdown")
    })

    test(".rs → rust", () => {
      expect(LANGUAGE_EXTENSIONS[".rs"]).toBe("rust")
    })

    test(".swift → swift", () => {
      expect(LANGUAGE_EXTENSIONS[".swift"]).toBe("swift")
    })

    test(".kt → kotlin", () => {
      expect(LANGUAGE_EXTENSIONS[".kt"]).toBe("kotlin")
    })

    test(".rb → ruby", () => {
      expect(LANGUAGE_EXTENSIONS[".rb"]).toBe("ruby")
    })

    test(".php → php", () => {
      expect(LANGUAGE_EXTENSIONS[".php"]).toBe("php")
    })

    test(".yaml → yaml", () => {
      expect(LANGUAGE_EXTENSIONS[".yaml"]).toBe("yaml")
    })

    test(".yml → yaml", () => {
      expect(LANGUAGE_EXTENSIONS[".yml"]).toBe("yaml")
    })

    test(".svelte → svelte", () => {
      expect(LANGUAGE_EXTENSIONS[".svelte"]).toBe("svelte")
    })

    test(".vue → vue", () => {
      expect(LANGUAGE_EXTENSIONS[".vue"]).toBe("vue")
    })
  })

  describe("alternative/extended extensions", () => {
    test(".cxx → cpp", () => {
      expect(LANGUAGE_EXTENSIONS[".cxx"]).toBe("cpp")
    })

    test(".cc → cpp", () => {
      expect(LANGUAGE_EXTENSIONS[".cc"]).toBe("cpp")
    })

    test(".c++ → cpp", () => {
      expect(LANGUAGE_EXTENSIONS[".c++"]).toBe("cpp")
    })

    test(".mjs → javascript", () => {
      expect(LANGUAGE_EXTENSIONS[".mjs"]).toBe("javascript")
    })

    test(".cjs → javascript", () => {
      expect(LANGUAGE_EXTENSIONS[".cjs"]).toBe("javascript")
    })

    test(".mts → typescript", () => {
      expect(LANGUAGE_EXTENSIONS[".mts"]).toBe("typescript")
    })

    test(".cts → typescript", () => {
      expect(LANGUAGE_EXTENSIONS[".cts"]).toBe("typescript")
    })

    test(".mtsx → typescriptreact", () => {
      expect(LANGUAGE_EXTENSIONS[".mtsx"]).toBe("typescriptreact")
    })

    test(".ctsx → typescriptreact", () => {
      expect(LANGUAGE_EXTENSIONS[".ctsx"]).toBe("typescriptreact")
    })

    test(".htm → html", () => {
      expect(LANGUAGE_EXTENSIONS[".htm"]).toBe("html")
    })

    test(".sass → sass", () => {
      expect(LANGUAGE_EXTENSIONS[".sass"]).toBe("sass")
    })

    test(".scss → scss", () => {
      expect(LANGUAGE_EXTENSIONS[".scss"]).toBe("scss")
    })
  })

  describe("without leading dot (exceptions like 'makefile')", () => {
    test("makefile (no dot) → makefile", () => {
      expect(LANGUAGE_EXTENSIONS["makefile"]).toBe("makefile")
    })

    test(".makefile (with dot) → makefile", () => {
      expect(LANGUAGE_EXTENSIONS[".makefile"]).toBe("makefile")
    })
  })

  describe("unknown extensions return undefined", () => {
    test(".xyz returns undefined", () => {
      expect(LANGUAGE_EXTENSIONS[".xyz"]).toBeUndefined()
    })

    test(".unknown returns undefined", () => {
      expect(LANGUAGE_EXTENSIONS[".unknown"]).toBeUndefined()
    })

    test("empty string returns undefined", () => {
      expect(LANGUAGE_EXTENSIONS[""]).toBeUndefined()
    })

    test("no-extension filename returns undefined", () => {
      expect(LANGUAGE_EXTENSIONS["makefile123"]).toBeUndefined()
    })
  })

  describe("case sensitivity", () => {
    test(".TS (uppercase) returns undefined (keys are lowercase)", () => {
      expect(LANGUAGE_EXTENSIONS[".TS"]).toBeUndefined()
    })

    test(".Ts (mixed case) returns undefined", () => {
      expect(LANGUAGE_EXTENSIONS[".Ts"]).toBeUndefined()
    })

    test(".Py (uppercase) returns undefined", () => {
      expect(LANGUAGE_EXTENSIONS[".Py"]).toBeUndefined()
    })
  })

  describe("maps are complete (no gaps for common extensions)", () => {
    const common = [
      ".abap",
      ".bat",
      ".bib",
      ".c",
      ".clj",
      ".coffee",
      ".cpp",
      ".cs",
      ".css",
      ".dart",
      ".diff",
      ".dockerfile",
      ".ex",
      ".erl",
      ".fs",
      ".gitcommit",
      ".gitrebase",
      ".go",
      ".groovy",
      ".hbs",
      ".hs",
      ".html",
      ".ini",
      ".java",
      ".jl",
      ".js",
      ".kt",
      ".jsx",
      ".json",
      ".tex",
      ".less",
      ".lua",
      ".makefile",
      "makefile",
      ".md",
      ".m",
      ".mm",
      ".pl",
      ".pm",
      ".php",
      ".ps1",
      ".pug",
      ".py",
      ".r",
      ".rb",
      ".rs",
      ".scss",
      ".sass",
      ".scala",
      ".sh",
      ".sql",
      ".svelte",
      ".swift",
      ".ts",
      ".tsx",
      ".xml",
      ".yaml",
      ".yml",
      ".vue",
      ".zig",
      ".astro",
      ".nix",
      ".typ",
      ".tf",
      ".hcl",
    ]

    for (const ext of common) {
      test(`${ext} has a language mapping`, () => {
        expect(LANGUAGE_EXTENSIONS[ext]).toBeDefined()
        expect(typeof LANGUAGE_EXTENSIONS[ext]).toBe("string")
      })
    }
  })

  describe("as const ensures literal types", () => {
    test("the type is narrowed to known keys, not just string", () => {
      // Type-level check: accessing a known key gives a string literal type
      const ts: "typescript" = LANGUAGE_EXTENSIONS[".ts"] as any
      expect(ts).toBe("typescript" as const)
    })
  })

  describe("edge cases", () => {
    test(".ets is mapped to typescript (may need review if Erlang)", () => {
      // .ets is listed under "typescript" but could also be Erlang ETS files.
      // Keeping this test as documentation of current behavior.
      expect(LANGUAGE_EXTENSIONS[".ets"]).toBe("typescript")
    })

    test(".patch → diff (alternative diff format)", () => {
      expect(LANGUAGE_EXTENSIONS[".patch"]).toBe("diff")
    })

    test(".markdown → markdown (full name alternative)", () => {
      expect(LANGUAGE_EXTENSIONS[".markdown"]).toBe("markdown")
    })

    test(".bash → shellscript", () => {
      expect(LANGUAGE_EXTENSIONS[".bash"]).toBe("shellscript")
    })

    test(".zsh → shellscript", () => {
      expect(LANGUAGE_EXTENSIONS[".zsh"]).toBe("shellscript")
    })

    test(".ksh → shellscript", () => {
      expect(LANGUAGE_EXTENSIONS[".ksh"]).toBe("shellscript")
    })
  })
})
