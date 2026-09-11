import { rm } from "fs/promises"
import { existsSync } from "fs"
import { Instance } from "../../src/project/instance"
import { Database } from "../../src/storage"
import { initProjectors } from "../../src/server/projectors"

/** Remove a file with Windows-aware retries.
 *  On Windows, recently-closed SQLite files may still be locked by the
 *  filesystem cache for a brief moment. */
async function rmRetry(filepath: string, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      await rm(filepath, { force: true })
      if (!existsSync(filepath)) return
    } catch {
      // ignore and retry
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 50 * (i + 1)))
  }
}

export async function resetDatabase() {
  await Instance.disposeAll().catch(() => undefined)
  Database.close()
  await rmRetry(Database.Path)
  await rmRetry(`${Database.Path}-wal`)
  await rmRetry(`${Database.Path}-shm`)
  // Restore sync projectors in case a previous test (e.g. sync/index.test.ts)
  // called SyncEvent.reset() and left the registry empty.
  initProjectors()
}
