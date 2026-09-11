import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { Project } from "../../src/project"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectID } from "../../src/project/schema"
import { Database } from "../../src/storage"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function run<A>(fn: (svc: Project.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* Project.Service
      return yield* fn(svc)
    }).pipe(Effect.provide(Project.defaultLayer)),
  )
}

/**
 * Project identity for a non-git directory must come from the database, never
 * from a marker file dropped inside the directory:
 *  - a plain directory used to get a `<dir>/duoduo` file written into the user's
 *    project tree;
 *  - a Plan C mirror got the same file, and because sync did not exclude it,
 *    every push uploaded it to the remote server (leaking host/port/path).
 */
describe("project identity writes nothing into the directory", () => {
  test("no database row: id is derived from the path, no marker file", async () => {
    await using tmp = await tmpdir()

    const { project } = await run((svc) => svc.fromDirectory(tmp.path))

    expect(project.id).toBe(ProjectID.make(tmp.path))
    expect(fs.existsSync(path.join(tmp.path, "duoduo"))).toBe(false)
  })

  test("database row wins: a remote mirror keeps its remote: id", async () => {
    await using tmp = await tmpdir()
    // Mirrors are non-git directories whose real identity lives in the DB
    // (`worktree` === mirror path, see `getByDirectory`).
    const id = ProjectID.make("remote:MzkuMTAwLjcwLjIyNzoyMjovd3d3L3d3d3Jvb3Q")
    Database.use((db) =>
      db
        .insert(ProjectTable)
        .values({
          id,
          worktree: tmp.path,
          vcs: null,
          sandboxes: [],
          time_created: 1,
          time_updated: 1,
        })
        .onConflictDoNothing()
        .run(),
    )

    const { project } = await run((svc) => svc.fromDirectory(tmp.path))

    expect(project.id).toBe(id)
    expect(project.id.startsWith("remote:")).toBe(true)
    // Still nothing written into the directory.
    expect(fs.existsSync(path.join(tmp.path, "duoduo"))).toBe(false)
  })

  test("discovery agrees with fromDirectory for a remote mirror", async () => {
    await using tmp = await tmpdir()
    const id = ProjectID.make("remote:c29tZS1taXJyb3I")
    Database.use((db) =>
      db
        .insert(ProjectTable)
        .values({
          id,
          worktree: tmp.path,
          vcs: null,
          sandboxes: [],
          time_created: 1,
          time_updated: 1,
        })
        .onConflictDoNothing()
        .run(),
    )

    const { project } = await run((svc) => svc.discoverProject(tmp.path))

    expect(project.id).toBe(id)
    expect(fs.existsSync(path.join(tmp.path, "duoduo"))).toBe(false)
  })
})
