import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Global } from "../../src/global"
import { cleanupOrphanProjectData, projectId } from "../../src/storage/project-dir"

const DATABASE_DIR = path.join(Global.Path.data, "database")
const LEDGER = path.join(Global.Path.state, "orphan-projects.json")

/** Track everything we create so the developer's real data dir stays untouched. */
let created: string[] = []
let ledgerBackup: string | undefined

function seedProjectData(projectPath: string): string {
  const id = projectId(projectPath)
  const dir = path.join(DATABASE_DIR, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({ precious: true }))
  created.push(dir)
  return dir
}

function readLedger(): Record<string, { since: number; count: number }> {
  try {
    return JSON.parse(fs.readFileSync(LEDGER, "utf-8"))
  } catch {
    return {}
  }
}

function writeLedger(value: Record<string, { since: number; count: number }>): void {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true })
  fs.writeFileSync(LEDGER, JSON.stringify(value))
}

beforeEach(() => {
  created = []
  ledgerBackup = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, "utf-8") : undefined
  fs.rmSync(LEDGER, { force: true })
})

afterEach(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
  if (ledgerBackup !== undefined) writeLedger(JSON.parse(ledgerBackup))
  else fs.rmSync(LEDGER, { force: true })
})

describe("cleanupOrphanProjectData", () => {
  test("keeps data for a project that still exists", () => {
    const live = fs.mkdtempSync(path.join(os.tmpdir(), "dd-live-"))
    const dir = seedProjectData(live)
    try {
      cleanupOrphanProjectData()
      expect(fs.existsSync(dir)).toBe(true)
      // A present project must not be tracked as an orphan at all.
      expect(readLedger()[projectId(live)]).toBeUndefined()
    } finally {
      fs.rmSync(live, { recursive: true, force: true })
    }
  })

  test("does NOT delete on first sighting of a missing path", () => {
    // This is the data-loss regression: a temporarily unreachable network or
    // FUSE mount reports `existsSync === false` exactly like a deleted folder.
    const missing = path.join(os.tmpdir(), `dd-unreachable-mount-${Date.now()}`)
    const dir = seedProjectData(missing)

    cleanupOrphanProjectData()

    expect(fs.existsSync(dir)).toBe(true)
    const record = readLedger()[projectId(missing)]
    expect(record).toBeDefined()
    expect(record!.count).toBe(1)
  })

  test("does NOT delete after many sightings inside the grace period", () => {
    const missing = path.join(os.tmpdir(), `dd-flapping-${Date.now()}`)
    const dir = seedProjectData(missing)

    for (let i = 0; i < 10; i++) cleanupOrphanProjectData()

    expect(fs.existsSync(dir)).toBe(true)
    expect(readLedger()[projectId(missing)]!.count).toBe(10)
  })

  test("does NOT delete once the grace period elapses if sightings are too few", () => {
    const missing = path.join(os.tmpdir(), `dd-rare-${Date.now()}`)
    const dir = seedProjectData(missing)
    const id = projectId(missing)

    writeLedger({ [id]: { since: Date.now() - 400 * 24 * 60 * 60 * 1000, count: 1 } })
    cleanupOrphanProjectData() // -> count 2, still below the minimum

    expect(fs.existsSync(dir)).toBe(true)
  })

  test("deletes once the path is absent past the grace period AND enough sightings", () => {
    const missing = path.join(os.tmpdir(), `dd-deleted-${Date.now()}`)
    const dir = seedProjectData(missing)
    const id = projectId(missing)

    writeLedger({ [id]: { since: Date.now() - 400 * 24 * 60 * 60 * 1000, count: 20 } })
    cleanupOrphanProjectData()

    expect(fs.existsSync(dir)).toBe(false)
    // The record is dropped along with the directory.
    expect(readLedger()[id]).toBeUndefined()
  })

  test("a single reappearance resets the countdown", () => {
    const live = fs.mkdtempSync(path.join(os.tmpdir(), "dd-remount-"))
    const dir = seedProjectData(live)
    const id = projectId(live)

    // Simulate a long outage that is one run away from deletion.
    writeLedger({ [id]: { since: Date.now() - 400 * 24 * 60 * 60 * 1000, count: 20 } })
    try {
      // The mount is back, so this run must clear the record instead of deleting.
      cleanupOrphanProjectData()
      expect(fs.existsSync(dir)).toBe(true)
      expect(readLedger()[id]).toBeUndefined()
    } finally {
      fs.rmSync(live, { recursive: true, force: true })
    }
  })

  test("a future-dated ledger entry cannot fast-track deletion", () => {
    const missing = path.join(os.tmpdir(), `dd-clockskew-${Date.now()}`)
    const dir = seedProjectData(missing)
    const id = projectId(missing)

    // Clock skew / a ledger copied from a machine set far ahead.
    writeLedger({ [id]: { since: Date.now() + 400 * 24 * 60 * 60 * 1000, count: 99 } })
    cleanupOrphanProjectData()

    expect(fs.existsSync(dir)).toBe(true)
    expect(readLedger()[id]!.since).toBeLessThanOrEqual(Date.now())
  })

  test("a corrupt ledger never causes deletion", () => {
    const missing = path.join(os.tmpdir(), `dd-corrupt-${Date.now()}`)
    const dir = seedProjectData(missing)

    fs.mkdirSync(path.dirname(LEDGER), { recursive: true })
    fs.writeFileSync(LEDGER, "{ this is not json")
    cleanupOrphanProjectData()

    expect(fs.existsSync(dir)).toBe(true)
  })

  test("projectId follows the hosting filesystem's case semantics", () => {
    // Project identity is decided by the physical filesystem, not the OS:
    // paths resolving to the same directory are one project, distinct
    // directories are distinct projects.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "dd-case-"))
    try {
      const lower = path.join(base, "duoidcase")
      fs.mkdirSync(lower)
      const idLower = projectId(lower)
      // The ground truth: is `duoidcase` visible under another casing?
      const fsInsensitive = fs.existsSync(path.join(base, "DUOIDCASE"))
      if (fsInsensitive) {
        expect(projectId(path.join(base, "DuoIdCase"))).toBe(idLower)
      } else {
        expect(projectId(path.join(base, "DuoIdCase"))).not.toBe(idLower)
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  })

  test("projectId round-trips so cleanup targets the right path", () => {
    // `some-project` does not exist → the probe cannot run → the platform
    // approximation applies (Windows/macOS case-insensitive, Linux sensitive).
    const p = path.resolve(os.tmpdir(), "some-project")
    const decoded = Buffer.from(projectId(p), "base64url").toString("utf-8")
    const insensitivePlatform = process.platform === "win32" || process.platform === "darwin"
    const expected = insensitivePlatform ? p.replace(/\\/g, "/").toLowerCase() : p
    expect(decoded).toBe(expected)
  })
})
