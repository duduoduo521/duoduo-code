import path from "path"
import { Global } from "../global"

/**
 * Root directory that holds local mirrors of remote (SSH/SFTP) projects.
 *
 * Layout: `<Global.Path.data>/remote-mirror`.
 * A concrete remote project's mirror lives at
 * `mirrorRoot()/<host>/<encoded remotePath>` (see `mirrorDir`).
 *
 * This directory is local-only state and never touches the remote server.
 * Clearing it (and re-pulling) is the supported recovery path for a corrupt
 * mirror, which is acceptable for this project's "re-create on demand" model.
 */
export function mirrorRoot(): string {
  return path.join(Global.Path.data, "remote-mirror")
}

/**
 * Local mirror directory for a specific remote project.
 *
 * `host` is used as a flat namespace segment so that distinct servers never
 * collide. `remotePath` is base64url-encoded (filesystem-safe, injective) the
 * same way `projectId` encodes paths, so distinct remote paths map to distinct
 * directories even when they contain `/`, spaces, or platform-specific chars.
 */
export function mirrorDir(host: string, remotePath: string): string {
  const encoded = Buffer.from(
    remotePath.replace(/\\/g, "/").replace(/\/+$/, ""),
    "utf-8",
  ).toString("base64url")
  return path.join(mirrorRoot(), host, encoded)
}

/**
 * Sync-state file for a specific remote project.
 *
 * It sits *beside* the mirror directory rather than inside it. The mirror is
 * what the user sees as their project, so nothing that is not remote content
 * belongs in there — a state file would show up in the file tree, could be
 * deleted by hand, and has to be excluded from every upload.
 */
export function mirrorStateFile(host: string, remotePath: string): string {
  return mirrorDir(host, remotePath) + ".state.json"
}
