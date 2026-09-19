import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"

const parameters = z.object({
  todos: z.array(z.object(Todo.Info.shape)).describe("The updated todo list"),
})

type Metadata = {
  todos: Todo.Info[]
}

export const TodoWriteTool = Tool.define<typeof parameters, Metadata, Todo.Service>(
  "todowrite",
  Effect.gen(function* () {
    const todo = yield* Todo.Service

    return {
      description: DESCRIPTION_WRITE,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "todowrite",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          // Echo the RESOLVED list (backend-assigned ids included), not the
          // raw model input — the todowrite prompt requires the model to pass
          // ids back on the next update, so brand-new tasks must return the
          // generated ids here.
          const resolved = yield* todo.update({
            sessionID: ctx.sessionID,
            todos: params.todos,
          })

          return {
            title: `${resolved.filter((x) => x.status !== "completed").length} todos`,
// @effect-diagnostics-next-line preferSchemaOverJson:off
            output: JSON.stringify(resolved, null, 2),
            metadata: {
              todos: resolved,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
