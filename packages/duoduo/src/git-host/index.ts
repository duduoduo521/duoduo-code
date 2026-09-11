/**
 * Git Host Provider — Abstract interface for GitHub, Gitee, and future platforms.
 *
 * Design reference: docs/优化.md §6 "GitHub/Gitee仓库创建功能"
 *
 * Provides:
 *   - Unified `GitHostProvider` interface for multi-platform git hosting
 *   - GitHub provider (using GitHub REST API v3)
 *   - Gitee provider (using Gitee API v5)
 *   - Device flow OAuth for desktop apps (no client secret exposed)
 *   - Remote URL parsing for both platforms
 */

// ─── Types ───

/** Options for creating a remote repository */
export interface CreateRepoOptions {
  /** Repository name (required) */
  name: string
  /** Repository description */
  description?: string
  /** Whether the repo should be private (default: true for safety) */
  private?: boolean
  /** Auto-init with README (default: false — we push existing code) */
  autoInit?: boolean
  /** Organization to create the repo under (optional, defaults to user account) */
  organization?: string
}

/** Result of creating a remote repository */
export interface RepoInfo {
  /** Full name: owner/repo */
  fullName: string
  /** HTTPS clone URL */
  cloneUrl: string
  /** SSH clone URL */
  sshUrl: string
  /** Web URL for the repository */
  htmlUrl: string
  /** Whether the repo is private */
  private: boolean
  /** Platform name (e.g. "github", "gitee") */
  platform: string
}

/** Options for creating a pull request */
export interface CreatePROptions {
  /** Repository owner */
  owner: string
  /** Repository name */
  repo: string
  /** PR title */
  title: string
  /** PR description/body */
  body?: string
  /** Head branch (source) */
  head: string
  /** Base branch (target) */
  base: string
}

/** Result of creating a pull request */
export interface PRInfo {
  /** PR number */
  number: number
  /** PR web URL */
  htmlUrl: string
  /** Platform name */
  platform: string
}

/** Parsed remote URL components */
export interface ParsedRemote {
  /** Repository owner/user */
  owner: string
  /** Repository name */
  repo: string
  /** Platform identifier */
  platform: string
}

/** Device flow result — code for user to enter, and a promise that resolves to the token */
export interface DeviceFlowResult {
  /** User-friendly code to display */
  userCode: string
  /** URL for the user to visit and enter the code */
  verificationUri: string
  /** Interval in seconds for polling (platform-specific) */
  intervalSeconds: number
  /** Promise that resolves with the access token once the user authorizes */
  token: Promise<string>
  /** Abort the device flow polling */
  abort: () => void
}

// ─── GitHostProvider Interface ───

export interface GitHostProvider {
  /** Platform identifier (e.g. "github", "gitee") */
  readonly name: string

  /** Parse a remote URL and extract owner/repo if it belongs to this platform */
  readonly parseRemote: (url: string) => ParsedRemote | null

  /** Create a remote repository via the platform API */
  readonly createRepo: (token: string, options: CreateRepoOptions) => Promise<RepoInfo>

  /** Create a pull request via the platform API */
  readonly createPR: (token: string, options: CreatePROptions) => Promise<PRInfo>

  /** Initiate device flow OAuth for desktop apps */
  readonly authDeviceFlow: (clientId: string) => Promise<DeviceFlowResult>
}

// ─── GitHub Provider ───

const GITHUB_REMOTE_REGEX = /(?:https?:\/\/|git@|ssh:\/\/)github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/

export const GitHubProvider: GitHostProvider = {
  name: "github",

  parseRemote(url: string): ParsedRemote | null {
    const match = url.match(GITHUB_REMOTE_REGEX)
    if (!match) return null
    return { owner: match[1]!, repo: match[2]!, platform: "github" }
  },

  async createRepo(token: string, options: CreateRepoOptions): Promise<RepoInfo> {
    const baseUrl = options.organization
      ? `https://api.github.com/orgs/${options.organization}/repos`
      : "https://api.github.com/user/repos"

    const body = {
      name: options.name,
      description: options.description ?? "",
      private: options.private ?? true,
      auto_init: options.autoInit ?? false,
    }

    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "DuoDuo-IDE",
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`GitHub API error (${res.status}): ${err}`)
    }

    const data = await res.json()
    return {
      fullName: data.full_name,
      cloneUrl: data.clone_url,
      sshUrl: data.ssh_url,
      htmlUrl: data.html_url,
      private: data.private,
      platform: "github",
    }
  },

  async createPR(token: string, options: CreatePROptions): Promise<PRInfo> {
    const url = `https://api.github.com/repos/${options.owner}/${options.repo}/pulls`
    const body = {
      title: options.title,
      body: options.body ?? "",
      head: options.head,
      base: options.base,
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "DuoDuo-IDE",
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`GitHub API error (${res.status}): ${err}`)
    }

    const data = await res.json()
    return {
      number: data.number,
      htmlUrl: data.html_url,
      platform: "github",
    }
  },

  async authDeviceFlow(clientId: string): Promise<DeviceFlowResult> {
    // Step 1: Request device code
    const res = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, scope: "repo" }),
    })

    if (!res.ok) {
      throw new Error(`GitHub device code request failed (${res.status})`)
    }

    const data = await res.json()
    const { device_code, user_code, verification_uri, interval } = data

    let aborted = false
    const abortController = new AbortController()

    // Step 2: Poll for token
    const tokenPromise = new Promise<string>((resolve, reject) => {
      const poll = async () => {
        if (aborted) {
          reject(new Error("Device flow aborted"))
          return
        }

        try {
          const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              client_id: clientId,
              device_code,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
            signal: abortController.signal,
          })

          const tokenData = await tokenRes.json()

          if (tokenData.access_token) {
            resolve(tokenData.access_token)
            return
          }

          if (tokenData.error === "authorization_pending") {
            // User hasn't entered the code yet, keep polling
            setTimeout(poll, (interval ?? 5) * 1000)
          } else if (tokenData.error === "slow_down") {
            // Rate limited, increase interval
            setTimeout(poll, ((interval ?? 5) + 5) * 1000)
          } else if (tokenData.error === "expired_token") {
            reject(new Error("Device code expired. Please try again."))
          } else if (tokenData.error === "access_denied") {
            reject(new Error("Authorization denied by user."))
          } else {
            reject(new Error(`GitHub OAuth error: ${tokenData.error_description ?? tokenData.error}`))
          }
        } catch (err) {
          if (!aborted) {
            reject(err)
          }
        }
      }

      setTimeout(poll, (interval ?? 5) * 1000)
    })

    return {
      userCode: user_code,
      verificationUri: verification_uri,
      intervalSeconds: interval ?? 5,
      token: tokenPromise,
      abort: () => {
        aborted = true
        abortController.abort()
      },
    }
  },
}

// ─── Gitee Provider ───

const GITEE_REMOTE_REGEX = /(?:https?:\/\/|git@|ssh:\/\/)gitee\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/

export const GiteeProvider: GitHostProvider = {
  name: "gitee",

  parseRemote(url: string): ParsedRemote | null {
    const match = url.match(GITEE_REMOTE_REGEX)
    if (!match) return null
    return { owner: match[1]!, repo: match[2]!, platform: "gitee" }
  },

  async createRepo(token: string, options: CreateRepoOptions): Promise<RepoInfo> {
    const baseUrl = options.organization
      ? `https://gitee.com/api/v5/orgs/${options.organization}/repos`
      : "https://gitee.com/api/v5/user/repos"

    const body = {
      access_token: token,
      name: options.name,
      description: options.description ?? "",
      private: (options.private ?? true) ? "1" : "0",
      auto_init: (options.autoInit ?? false) ? "1" : "0",
    }

    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Gitee API error (${res.status}): ${err}`)
    }

    const data = await res.json()
    const owner = options.organization ?? data.owner?.login ?? ""
    return {
      fullName: data.full_name ?? `${owner}/${options.name}`,
      cloneUrl: data.clone_url ?? `https://gitee.com/${owner}/${options.name}.git`,
      sshUrl: data.ssh_url ?? `git@gitee.com:${owner}/${options.name}.git`,
      htmlUrl: data.html_url ?? `https://gitee.com/${owner}/${options.name}`,
      private: data.private ?? options.private ?? true,
      platform: "gitee",
    }
  },

  async createPR(token: string, options: CreatePROptions): Promise<PRInfo> {
    const url = `https://gitee.com/api/v5/repos/${options.owner}/${options.repo}/pulls`
    const body = {
      access_token: token,
      title: options.title,
      body: options.body ?? "",
      head: options.head,
      base: options.base,
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Gitee API error (${res.status}): ${err}`)
    }

    const data = await res.json()
    return {
      number: data.number,
      htmlUrl: data.html_url,
      platform: "gitee",
    }
  },

  async authDeviceFlow(_clientId: string): Promise<DeviceFlowResult> {
    // Gitee does not natively support device flow like GitHub.
    // Fallback: use the authorization code flow with a redirect.
    // For desktop apps, this requires opening a browser and running a local callback server.
    throw new Error(
      "Gitee does not support device flow OAuth. " +
        "Please use the authorization code flow or provide a personal access token from https://gitee.com/profile/personal_access_tokens",
    )
  },
}

// ─── Provider Registry ───

const providers = new Map<string, GitHostProvider>([
  ["github", GitHubProvider],
  ["gitee", GiteeProvider],
])

/** Get a provider by platform name */
export function getProvider(platform: string): GitHostProvider | undefined {
  return providers.get(platform)
}

/** List all available platform names */
export function listPlatforms(): string[] {
  return Array.from(providers.keys())
}

/**
 * Parse a git remote URL and detect the hosting platform.
 * Supports GitHub and Gitee URLs in HTTPS, SSH, and git@ formats.
 */
export function detectGitHost(remoteUrl: string): ParsedRemote | null {
  for (const provider of providers.values()) {
    const result = provider.parseRemote(remoteUrl)
    if (result) return result
  }
  return null
}

/**
 * Get the appropriate provider for a given remote URL.
 */
export function getProviderForRemote(remoteUrl: string): GitHostProvider | null {
  const parsed = detectGitHost(remoteUrl)
  if (!parsed) return null
  return providers.get(parsed.platform) ?? null
}
