import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"
import {
  GitHubProvider,
  GiteeProvider,
  getProvider,
  listPlatforms,
  detectGitHost,
  getProviderForRemote,
} from "../../src/git-host"

// ─── parseRemote tests ───

describe("GitHubProvider.parseRemote", () => {
  test("HTTPS URL", () => {
    expect(GitHubProvider.parseRemote("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
      platform: "github",
    })
  })

  test("HTTPS with .git", () => {
    expect(GitHubProvider.parseRemote("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
      platform: "github",
    })
  })

  test("SSH format", () => {
    expect(GitHubProvider.parseRemote("git@github.com:owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
      platform: "github",
    })
  })

  test("SSH with .git", () => {
    expect(GitHubProvider.parseRemote("git@github.com:owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
      platform: "github",
    })
  })

  test("ssh:// format", () => {
    expect(GitHubProvider.parseRemote("ssh://git@github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
      platform: "github",
    })
  })

  test("ssh:// format with .git", () => {
    expect(GitHubProvider.parseRemote("ssh://git@github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
      platform: "github",
    })
  })

  test("Invalid URL returns null", () => {
    expect(GitHubProvider.parseRemote("not-a-url")).toBeNull()
  })

  test("Different domain returns null", () => {
    expect(GitHubProvider.parseRemote("https://gitee.com/owner/repo")).toBeNull()
  })

  test("Empty string returns null", () => {
    expect(GitHubProvider.parseRemote("")).toBeNull()
  })

  test("GitHub URL with trailing path segments", () => {
    expect(GitHubProvider.parseRemote("https://github.com/owner/repo/extra")).toBeNull()
  })
})

describe("GiteeProvider.parseRemote", () => {
  test("HTTPS URL", () => {
    expect(GiteeProvider.parseRemote("https://gitee.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
      platform: "gitee",
    })
  })

  test("HTTPS with .git", () => {
    expect(GiteeProvider.parseRemote("https://gitee.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
      platform: "gitee",
    })
  })

  test("SSH format", () => {
    expect(GiteeProvider.parseRemote("git@gitee.com:owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
      platform: "gitee",
    })
  })

  test("SSH with .git", () => {
    expect(GiteeProvider.parseRemote("git@gitee.com:owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
      platform: "gitee",
    })
  })

  test("ssh:// format", () => {
    expect(GiteeProvider.parseRemote("ssh://git@gitee.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
      platform: "gitee",
    })
  })

  test("Invalid URL returns null", () => {
    expect(GiteeProvider.parseRemote("not-a-url")).toBeNull()
  })

  test("Different domain returns null", () => {
    expect(GiteeProvider.parseRemote("https://github.com/owner/repo")).toBeNull()
  })

  test("Empty string returns null", () => {
    expect(GiteeProvider.parseRemote("")).toBeNull()
  })
})

// ─── Registry functions ───

describe("getProvider", () => {
  test("returns GitHubProvider for 'github'", () => {
    expect(getProvider("github")).toBe(GitHubProvider)
  })

  test("returns GiteeProvider for 'gitee'", () => {
    expect(getProvider("gitee")).toBe(GiteeProvider)
  })

  test("returns undefined for unknown platform", () => {
    expect(getProvider("unknown")).toBeUndefined()
  })
})

describe("listPlatforms", () => {
  test("returns ['github', 'gitee']", () => {
    const platforms = listPlatforms()
    expect(platforms).toContain("github")
    expect(platforms).toContain("gitee")
    expect(platforms).toHaveLength(2)
  })
})

describe("detectGitHost", () => {
  test("detects GitHub URL", () => {
    expect(detectGitHost("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
      platform: "github",
    })
  })

  test("detects Gitee URL", () => {
    expect(detectGitHost("https://gitee.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
      platform: "gitee",
    })
  })

  test("returns null for unknown domain", () => {
    expect(detectGitHost("https://gitlab.com/owner/repo")).toBeNull()
  })
})

describe("getProviderForRemote", () => {
  test("returns GitHubProvider for GitHub URL", () => {
    expect(getProviderForRemote("https://github.com/owner/repo")).toBe(GitHubProvider)
  })

  test("returns GiteeProvider for Gitee URL", () => {
    expect(getProviderForRemote("https://gitee.com/owner/repo")).toBe(GiteeProvider)
  })

  test("returns null for unknown domain", () => {
    expect(getProviderForRemote("https://gitlab.com/owner/repo")).toBeNull()
  })
})

// ─── GiteeProvider.authDeviceFlow ───

describe("GiteeProvider.authDeviceFlow", () => {
  test("always throws Error", async () => {
    try {
      await GiteeProvider.authDeviceFlow("some-client-id")
      expect.unreachable("Should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain("Gitee does not support device flow OAuth")
    }
  })
})

// ─── createRepo / createPR (fetch mock) ───

describe("GitHubProvider.createRepo", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("creates repo for user account", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            full_name: "user/my-repo",
            clone_url: "https://github.com/user/my-repo.git",
            ssh_url: "git@github.com:user/my-repo.git",
            html_url: "https://github.com/user/my-repo",
            private: true,
          }),
      } as Response),
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await GitHubProvider.createRepo("test-token", { name: "my-repo" })
    expect(result).toEqual({
      fullName: "user/my-repo",
      cloneUrl: "https://github.com/user/my-repo.git",
      sshUrl: "git@github.com:user/my-repo.git",
      htmlUrl: "https://github.com/user/my-repo",
      private: true,
      platform: "github",
    })
  })

  test("creates repo for organization", async () => {
    let capturedUrl = ""
    const mockFetch = mock((url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            full_name: "myorg/my-repo",
            clone_url: "https://github.com/myorg/my-repo.git",
            ssh_url: "git@github.com:myorg/my-repo.git",
            html_url: "https://github.com/myorg/my-repo",
            private: false,
          }),
      } as Response),
    )
    // Capture the URL from the mock call arguments
    const origCall = mockFetch.mock.calls
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await GitHubProvider.createRepo("test-token", { name: "my-repo", organization: "myorg" })
    expect((mockFetch.mock.calls[0] as any)[0]).toBe("https://api.github.com/orgs/myorg/repos")
  })

  test("throws on non-ok response", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 422,
        text: () => Promise.resolve("Validation Failed"),
      } as Response),
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    try {
      await GitHubProvider.createRepo("test-token", { name: "my-repo" })
      expect.unreachable("Should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain("GitHub API error (422)")
    }
  })
})

describe("GitHubProvider.createPR", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("creates pull request", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            number: 42,
            html_url: "https://github.com/owner/repo/pull/42",
          }),
      } as Response),
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await GitHubProvider.createPR("test-token", {
      owner: "owner",
      repo: "repo",
      title: "Fix bug",
      body: "Description",
      head: "feature",
      base: "main",
    })

    expect(result).toEqual({
      number: 42,
      htmlUrl: "https://github.com/owner/repo/pull/42",
      platform: "github",
    })
  })

  test("throws on non-ok response", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      } as Response),
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    try {
      await GitHubProvider.createPR("bad-token", {
        owner: "owner",
        repo: "repo",
        title: "Fix",
        head: "feature",
        base: "main",
      })
      expect.unreachable("Should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain("GitHub API error (401)")
    }
  })
})

describe("GiteeProvider.createRepo", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("creates repo for user account", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            full_name: "user/my-repo",
            clone_url: "https://gitee.com/user/my-repo.git",
            ssh_url: "git@gitee.com:user/my-repo.git",
            html_url: "https://gitee.com/user/my-repo",
            private: true,
            owner: { login: "user" },
          }),
      } as Response),
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await GiteeProvider.createRepo("test-token", { name: "my-repo" })
    expect(result.platform).toBe("gitee")
    expect(result.fullName).toBe("user/my-repo")
  })

  test("creates repo for organization", async () => {
    const mockFetch = mock((_url: string) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            full_name: "myorg/my-repo",
            clone_url: "https://gitee.com/myorg/my-repo.git",
            ssh_url: "git@gitee.com:myorg/my-repo.git",
            html_url: "https://gitee.com/myorg/my-repo",
            private: false,
            owner: { login: "myorg" },
          }),
      } as Response),
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    await GiteeProvider.createRepo("test-token", { name: "my-repo", organization: "myorg" })
    expect((mockFetch.mock.calls[0] as any)[0]).toBe("https://gitee.com/api/v5/orgs/myorg/repos")
  })

  test("throws on non-ok response", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      } as Response),
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    try {
      await GiteeProvider.createRepo("test-token", { name: "my-repo" })
      expect.unreachable("Should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain("Gitee API error (401)")
    }
  })

  test("uses fallback values when API response fields are missing", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            owner: { login: "user" },
          }),
      } as Response),
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await GiteeProvider.createRepo("test-token", {
      name: "my-repo",
      private: false,
    })

    expect(result.cloneUrl).toBe("https://gitee.com/user/my-repo.git")
    expect(result.sshUrl).toBe("git@gitee.com:user/my-repo.git")
    expect(result.htmlUrl).toBe("https://gitee.com/user/my-repo")
    expect(result.private).toBe(false)
  })
})

describe("GiteeProvider.createPR", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("creates pull request", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            number: 7,
            html_url: "https://gitee.com/owner/repo/pulls/7",
          }),
      } as Response),
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    const result = await GiteeProvider.createPR("test-token", {
      owner: "owner",
      repo: "repo",
      title: "Add feature",
      head: "feature",
      base: "master",
    })

    expect(result).toEqual({
      number: 7,
      htmlUrl: "https://gitee.com/owner/repo/pulls/7",
      platform: "gitee",
    })
  })

  test("throws on non-ok response", async () => {
    const mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 403,
        text: () => Promise.resolve("Forbidden"),
      } as Response),
    )
    globalThis.fetch = mockFetch as unknown as typeof fetch

    try {
      await GiteeProvider.createPR("test-token", {
        owner: "owner",
        repo: "repo",
        title: "Add feature",
        head: "feature",
        base: "master",
      })
      expect.unreachable("Should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain("Gitee API error (403)")
    }
  })
})
