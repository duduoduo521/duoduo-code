import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import * as path from "path"
import { Effect } from "effect"
import { HTTPException } from "hono/http-exception"
import { File } from "@/file"
import * as FileDelete from "@/file/delete"
import { Ripgrep } from "@/file/ripgrep"
import { LSP } from "@/lsp"
import { Instance } from "@/project/instance"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import * as Bom from "@/util/bom"
import { lazy } from "@/util/lazy"
import { Log } from "@/util"

const log = Log.create({ service: "file-routes" })
import { jsonRequest } from "./trace"

export const FileRoutes = lazy(() =>
  new Hono()
    .get(
      "/find",
      describeRoute({
        summary: "Find text",
        description: "Search for text patterns across files in the project using ripgrep.",
        operationId: "find.text",
        responses: {
          200: {
            description: "Matches",
            content: {
              "application/json": {
                schema: resolver(Ripgrep.Match.shape.data.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          pattern: z.string(),
        }),
      ),
      async (c) =>
        jsonRequest("FileRoutes.findText", c, function* () {
          const pattern = c.req.valid("query").pattern
          const svc = yield* Ripgrep.Service
          const result = yield* svc.search({ cwd: Instance.directory, pattern, limit: 10 })
          return result.items
        }),
    )
    .get(
      "/find/file",
      describeRoute({
        summary: "Find files",
        description: "Search for files or directories by name or pattern in the project directory.",
        operationId: "find.files",
        responses: {
          200: {
            description: "File paths",
            content: {
              "application/json": {
                schema: resolver(z.string().array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
          dirs: z.enum(["true", "false"]).optional(),
          type: z.enum(["file", "directory"]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      ),
      async (c) =>
        jsonRequest("FileRoutes.findFile", c, function* () {
          const query = c.req.valid("query")
          const svc = yield* File.Service
          return yield* svc.search({
            query: query.query,
            limit: query.limit ?? 10,
            dirs: query.dirs !== "false",
            type: query.type,
          })
        }),
    )
    .get(
      "/find/symbol",
      describeRoute({
        summary: "Find symbols",
        description: "Search for workspace symbols like functions, classes, and variables using LSP.",
        operationId: "find.symbols",
        responses: {
          200: {
            description: "Symbols",
            content: {
              "application/json": {
                schema: resolver(LSP.Symbol.zod.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          query: z.string(),
        }),
      ),
      async (c) => {
        return c.json([])
      },
    )
    .get(
      "/file",
      describeRoute({
        summary: "List files",
        description: "List files and directories in a specified path.",
        operationId: "file.list",
        responses: {
          200: {
            description: "Files and directories",
            content: {
              "application/json": {
                schema: resolver(File.Node.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) =>
        jsonRequest("FileRoutes.list", c, function* () {
          const svc = yield* File.Service
          return yield* svc.list(c.req.valid("query").path)
        }),
    )
    .get(
      "/file/content",
      describeRoute({
        summary: "Read file",
        description: "Read the content of a specified file.",
        operationId: "file.read",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/json": {
                schema: resolver(File.Content),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) =>
        jsonRequest("FileRoutes.read", c, function* () {
          const svc = yield* File.Service
          return yield* svc.read(c.req.valid("query").path)
        }),
    )
    .get(
      "/file/content/diff",
      describeRoute({
        summary: "Read file diff",
        description:
          "Get the git diff information for a specified file. Returns null if the file is not tracked by git or has no changes.",
        operationId: "file.readDiff",
        responses: {
          200: {
            description: "File diff content",
            content: {
              "application/json": {
                schema: resolver(File.DiffContent),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) =>
        jsonRequest("FileRoutes.readDiff", c, function* () {
          const svc = yield* File.Service
          return yield* svc.readDiff(c.req.valid("query").path)
        }),
    )
    .put(
      "/file/content",
      describeRoute({
        summary: "Write file",
        description: "Write content to a specified file. Creates the file and parent directories if they do not exist.",
        operationId: "file.write",
        responses: {
          200: {
            description: "Write result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                    path: z.string(),

                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string().describe("Absolute path to the file to write"),
          content: z.string().describe("The content to write to the file"),
        }),
      ),
      async (c) =>
        jsonRequest("FileRoutes.write", c, function* () {
          const { path: filePath, content } = c.req.valid("json")

          // Resolve to absolute path with consistent normalization.
          // Instance.directory is normalized via AppFileSystem.resolve() (which
          // calls realpathSync on Windows). We must apply the same normalization
          // to the file path, otherwise containsPath may fail due to case or
          // symlink differences on Windows.
          const resolvedPath = AppFileSystem.resolve(
            path.isAbsolute(filePath) ? filePath : path.resolve(Instance.directory, filePath),
          )

          // Security check: ensure path is within project boundary
          if (!Instance.containsPath(resolvedPath)) {
            throw new HTTPException(403, {
              message: `Path "${resolvedPath}" is outside the project boundary`,
            })
          }

          const fs = yield* AppFileSystem.Service
          const exists = yield* fs.existsSafe(resolvedPath)

          // Preserve BOM for existing files, otherwise use no BOM
          let desiredBom = false
          if (exists) {
            const source = yield* Bom.readFile(fs, resolvedPath)
            desiredBom = source.bom
          }

          yield* fs.writeWithDirs(resolvedPath, Bom.join(content, desiredBom))

          return { success: true, path: resolvedPath }
        }),
    )
    .post(
      "/file/mkdir",
      describeRoute({
        summary: "Create directory",
        description:
          "Create a directory (and any missing parents) at the specified path. " +
          "Lets the file tree create real empty folders instead of writing a " +
          ".gitkeep placeholder via the write endpoint. Idempotent: an existing " +
          "directory is left as-is and reported with created=false.",
        operationId: "file.mkdir",
        responses: {
          200: {
            description: "Directory creation result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                    path: z.string(),
                    created: z.boolean(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          path: z.string().describe("Directory path to create (relative to project root or absolute)"),
        }),
      ),
      async (c) =>
        jsonRequest("FileRoutes.mkdir", c, function* () {
          const { path: dirPath } = c.req.valid("json")

          // Same resolution + boundary semantics as the write route above.
          const resolvedPath = AppFileSystem.resolve(
            path.isAbsolute(dirPath) ? dirPath : path.resolve(Instance.directory, dirPath),
          )

          if (!Instance.containsPath(resolvedPath)) {
            throw new HTTPException(403, {
              message: `Path "${resolvedPath}" is outside the project boundary`,
            })
          }

          const fs = yield* AppFileSystem.Service
          const exists = yield* fs.existsSafe(resolvedPath)

          if (exists) {
            const stat = yield* fs.stat(resolvedPath)
            if (stat.type !== "Directory") {
              throw new HTTPException(409, {
                message: `Path "${resolvedPath}" exists and is not a directory`,
              })
            }
            return { success: true, path: resolvedPath, created: false }
          }

          yield* fs.makeDirectory(resolvedPath, { recursive: true })
          return { success: true, path: resolvedPath, created: true }
        }),
    )
    .delete(
      "/file",
      describeRoute({
        summary: "Delete file or directory",
        description: "Delete a file or directory at the specified path. On Windows the path is moved to the recycle bin through the shell API (executed by powershell.exe); when that is unavailable a paced recursive delete is used instead.",
        operationId: "file.delete",
        responses: {
          200: {
            description: "Delete result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                    path: z.string(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string().describe("Path to the file or directory to delete (relative to project root or absolute)"),
        }),
      ),
      async (c) =>
        jsonRequest("FileRoutes.delete", c, function* () {
          const filePath = c.req.valid("query").path

          const resolvedPath = AppFileSystem.resolve(
            path.isAbsolute(filePath) ? filePath : path.resolve(Instance.directory, filePath),
          )

          // Security check: ensure path is within project boundary
          if (!Instance.containsPath(resolvedPath)) {
            throw new HTTPException(403, {
              message: `Path "${resolvedPath}" is outside the project boundary`,
            })
          }

          const fs = yield* AppFileSystem.Service
          const exists = yield* fs.existsSafe(resolvedPath)

          if (!exists) {
            throw new HTTPException(404, {
              message: `Path "${resolvedPath}" does not exist`,
            })
          }

          const stat = yield* fs.stat(resolvedPath)
          const result = yield* FileDelete.remove(fs, resolvedPath, stat.type === "Directory")
          if (result.recycled) log.info("Deleted via recycle bin", { path: resolvedPath })

          return { success: true, path: resolvedPath }
        }),
    )
    .patch(
      "/file/rename",
      describeRoute({
        summary: "Rename or move a file or directory",
        description: "Rename or move a file or directory from oldPath to newPath.",
        operationId: "file.rename",
        responses: {
          200: {
            description: "Rename result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                    oldPath: z.string(),
                    newPath: z.string(),

                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          oldPath: z.string().describe("Current path of the file or directory"),
          newPath: z.string().describe("New path for the file or directory"),
        }),
      ),
      async (c) =>
        jsonRequest("FileRoutes.rename", c, function* () {
          const { oldPath: rawOldPath, newPath: rawNewPath } = c.req.valid("json")

          const resolvedOldPath = AppFileSystem.resolve(
            path.isAbsolute(rawOldPath) ? rawOldPath : path.resolve(Instance.directory, rawOldPath),
          )
          const resolvedNewPath = AppFileSystem.resolve(
            path.isAbsolute(rawNewPath) ? rawNewPath : path.resolve(Instance.directory, rawNewPath),
          )

          if (!Instance.containsPath(resolvedOldPath)) {
            throw new HTTPException(403, { message: `Path outside project boundary` })
          }
          if (!Instance.containsPath(resolvedNewPath)) {
            throw new HTTPException(403, { message: `Path outside project boundary` })
          }

          const fs = yield* AppFileSystem.Service
          const exists = yield* fs.existsSafe(resolvedOldPath)
          if (!exists) {
            throw new HTTPException(404, { message: `Path does not exist` })
          }

          yield* fs.copy(resolvedOldPath, resolvedNewPath)
          yield* fs.remove(resolvedOldPath, { recursive: true })

          return { success: true, oldPath: resolvedOldPath, newPath: resolvedNewPath }
        }),
    )
    .post(
      "/file/copy",
      describeRoute({
        summary: "Copy a file or directory",
        description: "Copy a file or directory from sourcePath to destinationPath.",
        operationId: "file.copy",
        responses: {
          200: {
            description: "Copy result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    success: z.boolean(),
                    sourcePath: z.string(),
                    destinationPath: z.string(),

                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          sourcePath: z.string().describe("Current path of the file or directory"),
          destinationPath: z.string().describe("Destination path for the copy"),
        }),
      ),
      async (c) =>
        jsonRequest("FileRoutes.copy", c, function* () {
          const { sourcePath: rawSource, destinationPath: rawDest } = c.req.valid("json")

          const resolvedSource = AppFileSystem.resolve(
            path.isAbsolute(rawSource) ? rawSource : path.resolve(Instance.directory, rawSource),
          )
          const resolvedDest = AppFileSystem.resolve(
            path.isAbsolute(rawDest) ? rawDest : path.resolve(Instance.directory, rawDest),
          )

          if (!Instance.containsPath(resolvedSource)) {
            throw new HTTPException(403, { message: `Path outside project boundary` })
          }
          if (!Instance.containsPath(resolvedDest)) {
            throw new HTTPException(403, { message: `Path outside project boundary` })
          }

          const fs = yield* AppFileSystem.Service
          const exists = yield* fs.existsSafe(resolvedSource)
          if (!exists) {
            throw new HTTPException(404, { message: `Source path does not exist` })
          }

          yield* fs.copy(resolvedSource, resolvedDest)

          return { success: true, sourcePath: resolvedSource, destinationPath: resolvedDest }
        }),
    )
    .get(
      "/file/status",
      describeRoute({
        summary: "Get file status",
        description: "Get the git status of all files in the project.",
        operationId: "file.status",
        responses: {
          200: {
            description: "File status",
            content: {
              "application/json": {
                schema: resolver(File.Info.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("FileRoutes.status", c, function* () {
          const svc = yield* File.Service
          return yield* svc.status()
        }),
    ),
)
