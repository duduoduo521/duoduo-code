import z from "zod"

export abstract class NamedError extends Error {
  abstract schema(): z.core.$ZodType
  abstract toObject(): { name: string; data: any }

  static hasName(error: unknown, name: string): boolean {
    return (
      typeof error === "object" && error !== null && "name" in error && (error as Record<string, unknown>).name === name
    )
  }

  static create<Name extends string, Data extends z.core.$ZodType>(name: Name, data: Data) {
    const schema = z
      .object({
        name: z.literal(name),
        data,
      })
      .meta({
        ref: name,
      })
    const result = class extends NamedError {
      public static readonly Schema = schema

      public override readonly name = name

      constructor(
        public readonly data: z.input<Data>,
        options?: ErrorOptions,
      ) {
        super(name, options)
        this.name = name
      }

      static isInstance(input: any): input is InstanceType<typeof result> {
        return typeof input === "object" && "name" in input && input.name === name
      }

      schema() {
        return schema
      }

      toObject() {
        return {
          name: name,
          data: this.data,
        }
      }
    }
    Object.defineProperty(result, "name", { value: name })
    return result
  }

  public static readonly Unknown = NamedError.create(
    "UnknownError",
    z.object({
      message: z.string(),
      // Optional retryability flag, transported verbatim from Rust's
      // UnifiedError::is_retryable over the SSE `error` event. When present the
      // TS retry policy trusts it as the single source of truth instead of
      // guessing from the message text.
      retryable: z.boolean().optional(),
      // Optional suggested retry delay in ms, transported from Rust's
      // UnifiedError::retry_after_ms (only `RateLimited`, e.g. upstream `Retry-After`).
      // When present the TS backoff honors the server's hint instead of guessing.
      retry_after_ms: z.number().optional(),
    }),
  )
}
