import { Hono } from "hono"
import { Log } from "@/util"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { Instance } from "@/project/instance"
import { Project } from "@/project"
import z from "zod"
import { ProjectID } from "@/project/schema"
import { badRequest, errors } from "../../error"
import { lazy } from "@/util/lazy"
import { InstanceBootstrap } from "@/project/bootstrap"
import { AppRuntime } from "@/effect/app-runtime"
import { jsonRequest, runRequest } from "./trace"
import { GitHubProvider, GiteeProvider, getProvider } from "@/git-host"
import { execSync } from "node:child_process"
import { listRemoteDir } from "@/remote/sync"
import { errorMessage } from "@/util/error"

const log = Log.create({ service: "project-routes" })

/** Execute a git command synchronously and return stdout. Throws on failure. */
function execGit(args: string[], opts?: { cwd?: string }): string {
  return execSync(`git ${args.join(" ")}`, {
    cwd: opts?.cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    windowsHide: true,
  }).trim()
}

export const ProjectRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List all projects",
        description: "Get a list of projects that have been opened with DuoDuoCode.",
        operationId: "project.list",
        responses: {
          200: {
            description: "List of projects",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const projects = Project.list()
        return c.json(projects)
      },
    )
    .get(
      "/current",
      describeRoute({
        summary: "Get current project",
        description: "Retrieve the currently active project that DuoDuoCode is working with.",
        operationId: "project.current",
        responses: {
          200: {
            description: "Current project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(Instance.project)
      },
    )
    .post(
      "/open",
      describeRoute({
        summary: "Open a project (create or refresh its record)",
        description:
          "Explicitly create or refresh the project record for a directory. This replaces the " +
          "implicit boot-time creation so that cleanup can delete records without them being " +
          "resurrected by instance boot (the sidecar is permanently bound to its launch directory).",
        operationId: "project.open",
        responses: {
          200: {
            description: "Project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
        },
      }),
      validator("json", z.object({ directory: z.string() })),
      async (c) => {
        const { directory } = c.req.valid("json")
        const { project } = await runRequest(
          "ProjectRoutes.open",
          c,
          Project.Service.use((svc) => svc.fromDirectory(directory, undefined, { create: true })),
        )
        return c.json(project)
      },
    )
    .post(
      "/git/init",
      describeRoute({
        summary: "Initialize git repository",
        description: "Create a git repository for the current project and return the refreshed project info.",
        operationId: "project.initGit",
        responses: {
          200: {
            description: "Project information after git initialization",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
        },
      }),
      async (c) => {
        const dir = Instance.directory
        const prev = Instance.project
        const next = await runRequest(
          "ProjectRoutes.initGit",
          c,
          Project.Service.use((svc) => svc.initGit({ directory: dir, project: prev })),
        )
        if (next.id === prev.id && next.vcs === prev.vcs && next.worktree === prev.worktree) return c.json(next)
        await Instance.reload({
          directory: dir,
          worktree: dir,
          project: next,
          init: () => AppRuntime.runPromise(InstanceBootstrap),
        })
        return c.json(next)
      },
    )
    .post(
      "/git/remote/create",
      describeRoute({
        summary: "Create remote repository",
        description:
          "Create a remote repository on GitHub or Gitee and add it as a git remote. " +
          "Requires a valid access token for the target platform.",
        operationId: "project.createRemote",
        responses: {
          200: {
            description: "Remote repository created and added as git remote",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    platform: z.string(),
                    fullName: z.string(),
                    cloneUrl: z.string(),
                    sshUrl: z.string(),
                    htmlUrl: z.string(),
                    private: z.boolean(),
                    remoteName: z.string(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 401),
        },
      }),
      validator(
        "json",
        z.object({
          platform: z.enum(["github", "gitee"]),
          token: z.string().min(1),
          name: z.string().min(1),
          description: z.string().optional(),
          private: z.boolean().optional().default(true),
          organization: z.string().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const dir = Instance.directory

        // Ensure git is initialized
        const prev = Instance.project
        if (prev.vcs !== "git") {
          return c.json(badRequest("Git is not initialized in this project"), 400)
        }

        // Select provider
        const provider = getProvider(body.platform)
        if (!provider) {
          return c.json(badRequest(`Unsupported platform: ${body.platform}`), 400)
        }

        // Create remote repo via platform API
        let result
        try {
          result = await provider.createRepo(body.token, {
            name: body.name,
            description: body.description,
            private: body.private,
            organization: body.organization,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn("Failed to create remote repository: " + message)
          return c.json(badRequest(`Failed to create remote repository: ${message}`), 400)
        }

        // Add remote origin
        const remoteName = "origin"
        try {
          execGit(["remote", "add", remoteName, result.cloneUrl], { cwd: dir })
        } catch (err) {
          // Remote might already exist; try set-url instead
          try {
            execGit(["remote", "set-url", remoteName, result.cloneUrl], { cwd: dir })
          } catch {
            return c.json(
              { error: `Failed to add git remote: ${err instanceof Error ? err.message : String(err)}` },
              400,
            )
          }
        }

        // Push current branch
        try {
          execGit(["push", "-u", remoteName, "HEAD"], { cwd: dir })
        } catch (err) {
          // Push failure is non-fatal — remote is still configured
          log.warn("git push failed after creating remote: " + (err instanceof Error ? err.message : String(err)))
        }

        return c.json({
          platform: result.platform,
          fullName: result.fullName,
          cloneUrl: result.cloneUrl,
          sshUrl: result.sshUrl,
          htmlUrl: result.htmlUrl,
          private: result.private,
          remoteName,
        })
      },
    )
    .post(
      "/connect-remote",
      describeRoute({
        summary: "Connect a remote (SSH/SFTP) directory",
        description:
          "Mirror a remote directory locally and register it as a project (Plan C). " +
          "Credentials are encrypted at rest. The local mirror is used as the project " +
          "root, so the entire main code path runs against the mirror with no divergence.",
        operationId: "project.connectRemote",
        responses: {
          200: {
            description: "Remote project connected and mirrored",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          host: z.string().min(1),
          port: z.number().int().positive().default(22),
          remotePath: z.string().min(1),
          auth: z.enum(["ssh-key", "password"]),
          username: z.string().min(1),
          secret: z.string().min(1),
          privateKey: z.string().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        try {
          const project = await Project.connectRemoteProject({
            host: body.host,
            port: body.port,
            remotePath: body.remotePath,
            auth: body.auth,
            username: body.username,
            secret: body.secret,
            privateKey: body.privateKey,
          })
          return c.json(project)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn("connectRemoteProject failed: " + message)
          return c.json(badRequest(`Failed to connect remote project: ${message}`), 400)
        }
      },
    )
    .post(
      "/disconnect-remote",
      describeRoute({
        summary: "Disconnect a remote (SSH/SFTP) project",
        description:
          "Disconnect a Plan C remote project. Always cleans up local traces: the " +
          "project row, the local mirror directory, and the encrypted credential " +
          "(secret + private-key file). This is a closed-loop disconnect. " +
          "Set `deleteRemote: true` (a separate, explicit confirmation) to also " +
          "recursively delete the files on the remote server — irreversible, so it " +
          "is never the default.",
        operationId: "project.disconnectRemote",
        responses: {
          200: {
            description: "Remote project disconnected",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    remoteDeleted: z.boolean(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "json",
        z.object({
          projectID: ProjectID.zod,
          deleteRemote: z.boolean().optional().default(false),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        try {
          const result = await Project.disconnectRemoteProject({
            id: body.projectID,
            deleteRemote: body.deleteRemote,
          })
          return c.json(result)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn("disconnectRemoteProject failed: " + message)
          return c.json(badRequest(`Failed to disconnect remote project: ${message}`), 400)
        }
      },
    )
    .post(
      "/remote/credential",
      describeRoute({
        summary: "Update SSH credentials of a remote project",
        description:
          "Update only the credentials (username / password / private key / auth kind) of an " +
          "existing Plan C remote project. The connection identity (host/port/remotePath) is " +
          "immutable, so no mirror / instance / session / KG state is affected. Safe to call " +
          "on an already-open project.",
        operationId: "project.updateRemoteCredential",
        responses: {
          200: {
            description: "Remote project credentials updated",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("json", z.object({
        projectID: ProjectID.zod,
        auth: z.enum(["ssh-key", "password"]),
        username: z.string().optional(),
        secret: z.string().optional(),
        privateKey: z.string().optional(),
      })),
      async (c) => {
        const body = c.req.valid("json")
        try {
          const project = await Project.updateRemoteCredential({
            id: body.projectID,
            auth: body.auth,
            username: body.username,
            secret: body.secret,
            privateKey: body.privateKey,
          })
          return c.json(project)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn("updateRemoteCredential failed: " + message)
          return c.json(badRequest(`Failed to update remote credentials: ${message}`), 400)
        }
      },
    )
    .post(
      "/remote/list",
      describeRoute({
        summary: "List a directory on the remote host",
        description:
          "Lists directories under a remote path so the user can browse the server instead of typing a path. Connects directly from the supplied options (no saved credential required).",
        operationId: "project.remoteList",
        responses: {
          200: {
            description: "Remote directory entries (directories and files)",
            content: {
              "application/json": {
                schema: resolver(
                  z.array(
                    z.object({
                      name: z.string(),
                      type: z.enum(["directory", "file"]),
                      size: z.number(),
                      mtime: z.number(),
                    }),
                  ),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          host: z.string(),
          port: z.number().int(),
          username: z.string().optional(),
          auth: z.enum(["ssh-key", "password"]),
          secret: z.string(),
          privateKey: z.string().optional(),
          dir: z.string().default(""),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        try {
          const entries = await listRemoteDir({
            host: body.host,
            port: body.port,
            username: body.username,
            auth: body.auth === "ssh-key" ? "publicKey" : "password",
            secret: body.secret,
            privateKey: body.privateKey,
            dir: body.dir,
          })
          return c.json(entries)
        } catch (err) {
          const message = errorMessage(err)
          log.warn("listRemoteDir failed: " + message)
          return c.json(badRequest(`Failed to list remote directory: ${message}`), 400)
        }
      },
    )
    .post(
      "/push-remote",
      describeRoute({
        summary: "Push local mirror changes back to the remote (Plan C upload)",
        description:
          "Uploads the local mirror of a remote (Plan C) project back to the remote server via SFTP.",
        operationId: "project.pushRemote",
        responses: {
          200: {
            description: "Mirror pushed to remote successfully",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    conflicts: { type: "array", items: { type: "string" } },
                    skipped: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("json", z.object({ projectID: ProjectID.zod, force: z.boolean().optional().default(false) })),
      async (c) => {
        const body = c.req.valid("json")
        try {
          const { conflicts, skipped } = await Project.pushRemote({ id: body.projectID, force: body.force })
          return c.json({ ok: true, conflicts, skipped })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn("pushRemote failed: " + message)
          return c.json(badRequest(`Failed to push to remote: ${message}`), 400)
        }
      },
    )
    .post(
      "/pull-remote",
      describeRoute({
        summary: "Pull remote changes into the local mirror (Plan C download)",
        description:
          "Downloads the remote tree of a remote (Plan C) project into the local mirror via SFTP. " +
          "Detects git-style conflicts (local changed since last sync while remote also changed) and " +
          "reports them without overwriting local changes.",
        operationId: "project.pullRemote",
        responses: {
          200: {
            description: "Mirror pulled from remote; conflicts list may be non-empty",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    conflicts: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("json", z.object({ projectID: ProjectID.zod, force: z.boolean().optional().default(false) })),
      async (c) => {
        const body = c.req.valid("json")
        try {
          const { conflicts } = await Project.pullRemote({ id: body.projectID, force: body.force })
          return c.json({ ok: true, conflicts })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn("pullRemote failed: " + message)
          return c.json(badRequest(`Failed to pull from remote: ${message}`), 400)
        }
      },
    )
    .post(
      "/remote/check",
      describeRoute({
        summary: "Probe SSH reachability for a saved remote project",
        description:
          "Checks whether a saved Plan C remote project can still be reached, without " +
          "pulling the tree or mutating local state. Used before opening a recent/sidebar " +
          "SSH project so a dead server does not mount an empty session. Credentials are " +
          "resolved server-side; no plaintext secret is ever returned.",
        operationId: "project.remoteCheck",
        responses: {
          200: {
            description: "Reachability probe result (ok: true on success, ok: false with error on failure)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    error: { type: "string" },
                  },
                },
              },
            },
          },
        },
      }),
      validator("json", z.object({ projectID: ProjectID.zod })),
      async (c) => {
        const body = c.req.valid("json")
        const result = await Project.remoteCheck({ id: body.projectID })
        return c.json(result)
      },
    )
    .post(
      "/cleanup-count",
      describeRoute({
        summary: "Count project records that would be cleaned up",
        description:
          "Counts project records older than `days` (0 = all) that are eligible for cleanup. " +
          "Projects currently open or present in the left sidebar (protectedWorktrees) are excluded.",
        operationId: "project.cleanupCount",
        responses: {
          200: {
            description: "Number of project records that would be deleted",
            content: {
              "application/json": {
                schema: { type: "object", properties: { count: { type: "number" } } },
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          days: z.number(),
          protectedWorktrees: z.array(z.string()).optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const count = await Project.countProjectsBefore({
          days: body.days,
          protectedWorktrees: body.protectedWorktrees,
        })
        return c.json({ count })
      },
    )
    .post(
      "/cleanup",
      describeRoute({
        summary: "Clean up old project records",
        description:
          "Deletes project records older than `days` (0 = all). Open projects and those in the " +
          "left sidebar (protectedWorktrees) are skipped. Deleting a record removes its DB row and " +
          "per-project data directory (sessions/messages/memory); the user's actual project directory " +
          "is never touched. Remote (Plan C) projects keep their local mirror and credentials. " +
          "When `worktrees` is set, only these projects are destroyed (days is ignored) and their " +
          "instances are disposed first.",
        operationId: "project.cleanup",
        responses: {
          200: {
            description: "Cleanup result",
            content: {
              "application/json": {
                schema: { type: "object", properties: { deleted: { type: "number" } } },
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          days: z.number(),
          protectedWorktrees: z.array(z.string()).optional(),
          // 定向模式：只销毁这些 worktree 对应的项目（忽略 days 阈值）。
          worktrees: z.array(z.string()).optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        try {
          // 定向模式（侧栏"删除项目"流程）：先释放每个目标项目的实例，
          // 其 DB 客户端 / watcher / 文件运行时全部停止后再删除数据目录，
          // 否则打开的句柄会让删除在 Windows 上失败。
          for (const directory of body.worktrees ?? []) {
            await Instance.disposeDirectory(directory, 5000)
          }
          const result = await Project.destroyProjectsBefore({
            days: body.days,
            protectedWorktrees: body.protectedWorktrees,
            worktrees: body.worktrees,
          })
          return c.json(result)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn("cleanup failed: " + message)
          return c.json(badRequest(`Failed to clean up projects: ${message}`), 400)
        }
      },
    )
    .patch(
      "/:projectID",
      describeRoute({
        summary: "Update project",
        description: "Update project properties such as name, icon, and commands.",
        operationId: "project.update",
        responses: {
          200: {
            description: "Updated project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info.zod),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod })),
      validator("json", Project.UpdateInput.omit({ projectID: true })),
      async (c) =>
        jsonRequest("ProjectRoutes.update", c, function* () {
          const projectID = c.req.valid("param").projectID
          const body = c.req.valid("json")
          const svc = yield* Project.Service
          return yield* svc.update({ ...body, projectID })
        }),
    ),
)
