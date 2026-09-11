import path from "path"
import os from "os"
import { Global } from "../global"

const home = os.homedir()

// macOS directories that trigger TCC (Transparency, Consent, and Control)
// permission prompts when accessed by a non-sandboxed process.
const DARWIN_HOME = [
  // Media
  "Music",
  "Pictures",
  "Movies",
  // User-managed folders synced via iCloud / subject to TCC
  "Downloads",
  "Desktop",
  "Documents",
  // Other system-managed
  "Public",
  "Applications",
  "Library",
]

const DARWIN_LIBRARY = [
  "Application Support/AddressBook",
  "Calendars",
  "Mail",
  "Messages",
  "Safari",
  "Cookies",
  "Application Support/com.apple.TCC",
  "PersonalizationPortrait",
  "Metadata/CoreSpotlight",
  "Suggestions",
]

const DARWIN_ROOT = ["/.DocumentRevisions-V100", "/.Spotlight-V100", "/.Trashes", "/.fseventsd"]

const WIN32_HOME = ["AppData", "Downloads", "Desktop", "Documents", "Pictures", "Music", "Videos", "OneDrive"]

// Sensitive directories containing credentials, keys, and secrets
// that must never be read by LLM tools regardless of permissions.
const SENSITIVE_DIRS = [
  // DuoDuo data directory (auth.json, mcp-auth.json, duoduo.db, etc.)
  Global.Path.data,
  // SSH keys and configuration
  path.join(home, ".ssh"),
  // AWS credentials and configuration
  path.join(home, ".aws"),
  // GPG keys
  path.join(home, ".gnupg"),
  // User config directory (may contain various credentials)
  path.join(home, ".config"),
]

/** Directory basenames to skip when scanning the home directory. */
export function names(): ReadonlySet<string> {
  if (process.platform === "darwin") return new Set(DARWIN_HOME)
  if (process.platform === "win32") return new Set(WIN32_HOME)
  return new Set()
}

/** Absolute paths that should never be watched, stated, or scanned. */
export function paths(): string[] {
  const platformPaths = (() => {
    if (process.platform === "darwin")
      return [
        ...DARWIN_HOME.map((n) => path.join(home, n)),
        ...DARWIN_LIBRARY.map((n) => path.join(home, "Library", n)),
        ...DARWIN_ROOT,
      ]
    if (process.platform === "win32") return WIN32_HOME.map((n) => path.join(home, n))
    return []
  })()
  return [...platformPaths, ...SENSITIVE_DIRS]
}

/** Check if a given absolute path is inside a protected/sensitive directory. */
export function isProtected(target: string): boolean {
  const normalized = path.resolve(target)
  for (const dir of SENSITIVE_DIRS) {
    const normalizedDir = path.resolve(dir)
    // Exact match or is a child of the protected directory
    if (normalized === normalizedDir || normalized.startsWith(normalizedDir + path.sep)) {
      return true
    }
  }
  // Also block project-internal sensitive files (keys, .env, db, ...).
  return isSensitivePath(target)
}

// Project-internal sensitive path components (exact match, not substring).
// Mirrors the Rust `security_design::sanitize::is_sensitive_path`.
// `.env` is matched exactly so `.env.example` (a non-secret template) stays
// readable; `.config` is excluded to avoid blocking legitimate build dirs.
const SENSITIVE_PATH_COMPONENTS = [
  ".env",
  "auth.json",
  "mcp-auth.json",
  "credentials",
  "duoduo.key",
  ".key-seed",
  "secure-keys",
  "secure-keys.enc.json",
  "duoduo.db",
  ".ssh",
  ".aws",
  ".gnupg",
]

/** Check if any path component matches a known sensitive name. */
export function isSensitivePath(filepath: string): boolean {
  const normalized = path.resolve(filepath).replace(/\\/g, "/")
  return normalized.split("/").some((component) => SENSITIVE_PATH_COMPONENTS.includes(component))
}

export * as Protected from "./protected"
