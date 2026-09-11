/**
 * Playwright global setup.
 *
 * Since the dev-server wrapper (dev-server.ts) handles starting the
 * mock LLM and isolated backend, this setup just verifies the runtime
 * info file exists and is readable.
 *
 * The globalSetup is still needed to:
 *   - Validate the runtime info
 *   - Store process references for teardown (if needed)
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { RuntimeInfo } from "./dev-server"

const __dirname = dirname(fileURLToPath(import.meta.url))
export const RUNTIME_INFO_PATH = resolve(__dirname, ".runtime-info.json")

export default async function globalSetup() {
  // Wait for the runtime info file to appear (written by dev-server.ts)
  const maxWait = 60_000
  const start = Date.now()
  while (!existsSync(RUNTIME_INFO_PATH)) {
    if (Date.now() - start > maxWait) {
      throw new Error(
        `Runtime info file not found at ${RUNTIME_INFO_PATH} after ${maxWait}ms. ` +
          `Did the dev-server wrapper start correctly?`,
      )
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  const info: RuntimeInfo = JSON.parse(readFileSync(RUNTIME_INFO_PATH, "utf8"))

  // Validate the backend is reachable
  try {
    const res = await fetch(`${info.backendUrl}/doc`, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) {
      throw new Error(`Backend /doc returned status ${res.status}`)
    }
  } catch (err) {
    throw new Error(`Backend at ${info.backendUrl} is not reachable: ${String(err)}`, { cause: err })
  }

  // eslint-disable-next-line no-console
  console.log(
    `[e2e:setup] runtime info loaded: backend=${info.backendUrl} project=${info.projectDir} pathEnc=${info.projectPathEncoded}`,
  )
}
