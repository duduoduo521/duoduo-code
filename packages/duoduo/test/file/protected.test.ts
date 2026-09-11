import { describe, test, expect } from "bun:test"
import path from "path"
import os from "os"
import { Protected } from "../../src/file/protected"

const home = os.homedir()

describe("Protected.isProtected", () => {
  describe("sensitive directories are protected", () => {
    test("~/.ssh/ is protected", () => {
      expect(Protected.isProtected(path.join(home, ".ssh"))).toBe(true)
      expect(Protected.isProtected(path.join(home, ".ssh", "id_rsa"))).toBe(true)
      expect(Protected.isProtected(path.join(home, ".ssh", "config"))).toBe(true)
      expect(Protected.isProtected(path.join(home, ".ssh", "authorized_keys"))).toBe(true)
    })

    test("~/.aws/ is protected", () => {
      expect(Protected.isProtected(path.join(home, ".aws"))).toBe(true)
      expect(Protected.isProtected(path.join(home, ".aws", "credentials"))).toBe(true)
      expect(Protected.isProtected(path.join(home, ".aws", "config"))).toBe(true)
    })

    test("~/.gnupg/ is protected", () => {
      expect(Protected.isProtected(path.join(home, ".gnupg"))).toBe(true)
      expect(Protected.isProtected(path.join(home, ".gnupg", "private-keys-v1.d", "ABC.key"))).toBe(true)
      expect(Protected.isProtected(path.join(home, ".gnupg", "pubring.kbx"))).toBe(true)
    })

    test("~/.config/ is protected", () => {
      expect(Protected.isProtected(path.join(home, ".config"))).toBe(true)
      expect(Protected.isProtected(path.join(home, ".config", "some-app", "config.json"))).toBe(true)
    })
  })

  describe("Global.Path.data is protected", () => {
    test("duoduo data directory is protected", () => {
      // Global.Path.data is dynamically computed, but Protected.isProtected
      // uses the same SENSITIVE_DIRS array at module level.
      // Verify that the data path is among protected paths.
      const protectedPaths = Protected.paths()
      const dataPath = protectedPaths.find((p) => p.includes("duoduocode") || p.includes("duoduocode-dev"))
      expect(dataPath).toBeDefined()
      expect(Protected.isProtected(dataPath!)).toBe(true)
    })

    test("files inside data directory are protected", () => {
      const protectedPaths = Protected.paths()
      const dataPath = protectedPaths.find((p) => p.includes("duoduocode") || p.includes("duoduocode-dev"))
      expect(dataPath).toBeDefined()
      expect(Protected.isProtected(path.join(dataPath!, "auth.json"))).toBe(true)
      expect(Protected.isProtected(path.join(dataPath!, "mcp-auth.json"))).toBe(true)
      expect(Protected.isProtected(path.join(dataPath!, "duoduo.db"))).toBe(true)
    })
  })

  describe("normal project paths are not protected", () => {
    test("project directory is not protected", () => {
      expect(Protected.isProtected("/home/user/project")).toBe(false)
      expect(Protected.isProtected("/Users/dev/my-project")).toBe(false)
    })

    test("project source files are not protected", () => {
      expect(Protected.isProtected("/home/user/project/src/index.ts")).toBe(false)
      expect(Protected.isProtected("/Users/dev/my-project/package.json")).toBe(false)
    })

    test("/tmp directory is not protected", () => {
      expect(Protected.isProtected("/tmp")).toBe(false)
      expect(Protected.isProtected("/tmp/some-project")).toBe(false)
    })
  })

  describe("path traversal attempts are protected", () => {
    test("../ escape from a sibling directory still resolves to protected path", () => {
      // If we resolve path.join(home, ".ssh", "..", ".ssh") it should be protected
      expect(Protected.isProtected(path.join(home, ".ssh", "..", ".ssh"))).toBe(true)
    })

    test("../ escape into a non-protected path is not protected", () => {
      // path.resolve resolves .., so this becomes /home/user/project
      expect(Protected.isProtected(path.join(home, "project", "..", "other-project"))).toBe(false)
    })

    test("path with .. that resolves to protected dir is still caught", () => {
      // Craft a path that resolves to ~/.ssh via ..
      const escapePath = path.join(home, "some-dir", "..", ".ssh")
      expect(Protected.isProtected(escapePath)).toBe(true)
    })
  })

  describe("exact match vs prefix", () => {
    test("exact protected directory path is protected", () => {
      expect(Protected.isProtected(path.join(home, ".ssh"))).toBe(true)
    })

    test("child of protected directory is protected", () => {
      expect(Protected.isProtected(path.join(home, ".ssh", "subdir", "file"))).toBe(true)
    })

    test("path with same prefix but different directory is not protected", () => {
      // ~/.sshkit should NOT be protected (prefix collision)
      expect(Protected.isProtected(path.join(home, ".sshkit"))).toBe(false)
      expect(Protected.isProtected(path.join(home, ".awsbackup"))).toBe(false)
      expect(Protected.isProtected(path.join(home, ".gnupg2"))).toBe(false)
    })
  })
})
