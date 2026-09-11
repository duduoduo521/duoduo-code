/**
 * Playwright global teardown.
 *
 * Since the dev-server wrapper handles cleanup when Playwright kills it,
 * this teardown just removes the runtime info file.
 */
import { existsSync, rmSync } from "node:fs"
import { RUNTIME_INFO_PATH } from "./global-setup"

export default async function globalTeardown() {
  if (existsSync(RUNTIME_INFO_PATH)) {
    try {
      rmSync(RUNTIME_INFO_PATH, { force: true })
    } catch {
      // ignore
    }
  }
  // eslint-disable-next-line no-console
  console.log("[e2e:teardown] done")
}
