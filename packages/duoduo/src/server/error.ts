import { resolver } from "hono-openapi"
import z from "zod"
import { NotFoundError } from "../storage"

export const ERRORS = {
  400: {
    description: "Bad request",
    content: {
      "application/json": {
        schema: resolver(
          z
            .object({
              data: z.any(),
              errors: z.array(z.record(z.string(), z.any())),
              success: z.literal(false),
            })
            .meta({
              ref: "BadRequestError",
            }),
        ),
      },
    },
  },
  404: {
    description: "Not found",
    content: {
      "application/json": {
        schema: resolver(NotFoundError.Schema),
      },
    },
  },
} as const

export function errors(...codes: number[]) {
  return Object.fromEntries(codes.map((code) => [code, ERRORS[code as keyof typeof ERRORS]]))
}

/**
 * Response body for a 400, matching the schema `errors(400)` declares
 * (`BadRequestError`: `{ data, errors, success: false }`). Handlers must use this
 * instead of a bare `{ error }`, otherwise the documented contract and the wire
 * format disagree and the generated client type is unusable.
 *
 * The message lives at `data.error`, which both frontend extractors already read
 * (`context/file/error-message.ts` and `util/format-error-message.ts`).
 */
export function badRequest(message: string) {
  return { data: { error: message }, errors: [] as Array<Record<string, unknown>>, success: false as const }
}
