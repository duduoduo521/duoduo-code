import { Hono } from "hono"
import { Effect } from "effect"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { startForceReindex } from "@/project/bootstrap"
import { jsonRequest } from "./trace"

export const GraphRoutes = lazy(() =>
  new Hono().post(
    "/reindex",
    describeRoute({
      summary: "Force reindex knowledge graph",
      description:
        "Trigger a full reindex of the knowledge graph. The project is identified by its " +
        "directory — the backend derives the index key from it, so callers never have to " +
        "reconstruct one. Progress is broadcast via SSE (graph.index-status events).",
      operationId: "graph.reindex",
      responses: {
        200: {
          description: "Reindex started",
          content: {
            "application/json": {
              schema: resolver(z.object({ started: z.boolean() })),
            },
          },
        },
      },
    }),
    validator("json", z.object({ projectPath: z.string() })),
    async (c) =>
      jsonRequest("GraphRoutes.reindex", c, function* () {
        const { projectPath } = c.req.valid("json")
        yield* Effect.forkDetach(startForceReindex(projectPath))
        return { started: true }
      }),
  ),
)
