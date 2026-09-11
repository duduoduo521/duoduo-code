import { DuoduoError } from "@/util/error"
import z from "zod"
import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Tool from "./tool"
import DESCRIPTION from "./symbol_search.txt"

const FALLBACK_MESSAGE = "Symbol search not available. Use grep for text-based search instead."

const SymbolSearchParams = Schema.Struct({
  query: Schema.String,
  kind: Schema.String,
  file_pattern: Schema.optional(Schema.UndefinedOr(Schema.String)),
  limit: Schema.Number,
})

const SymbolResult = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  path: Schema.String,
  line: Schema.Number,
})

const SymbolSearchResponse = Schema.Struct({
  symbols: Schema.Array(SymbolResult),
})

type SymbolSearchResponseType = typeof SymbolSearchResponse.Type

const decodeResponse = Schema.decodeUnknownEffect(SymbolSearchResponse)

export const SymbolSearchTool = Tool.define(
  "symbol_search",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    return {
      description: DESCRIPTION,
      parameters: z.object({
        query: z.string().describe("Symbol name to search for (substring match)"),
        kind: z
          .enum(["function", "class", "struct", "interface", "enum", "const", "all"])
          .optional()
          .default("all")
          .describe("Symbol kind filter"),
        file_pattern: z.string().optional().describe("File path filter (e.g. 'src/**/*.rs')"),
        limit: z.number().optional().default(20).describe("Maximum number of results"),
      }),
      execute: (
        params: {
          query: string
          kind?: "function" | "class" | "struct" | "interface" | "enum" | "const" | "all"
          file_pattern?: string
          limit?: number
        },
        ctx: Tool.Context,
      ) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "symbol_search",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              kind: params.kind ?? "all",
              file_pattern: params.file_pattern,
              limit: params.limit ?? 20,
            },
          })

          const request = yield* HttpClientRequest.schemaBodyJson(SymbolSearchParams)({
            query: params.query,
            kind: params.kind ?? "all",
            file_pattern: params.file_pattern,
            limit: params.limit ?? 20,
          })(HttpClientRequest.post("/code-search/symbols"))

          const result: SymbolSearchResponseType | null = yield* Effect.gen(function* () {
            const response = yield* HttpClient.filterStatusOk(http)
              .execute(request)
              .pipe(
                Effect.timeoutOrElse({
                  duration: "10 seconds",
                  orElse: () => Effect.fail(new DuoduoError({ message: "Symbol search request timed out", messageZh: "符号搜索请求超时", cause: undefined })),
                }),
              )
            const body = yield* response.json
            return yield* decodeResponse(body)
          }).pipe(Effect.catch(() => Effect.succeed(null)))

          if (!result || result.symbols.length === 0) {
            return {
              title: params.query,
              metadata: { matches: 0, truncated: false },
              output: result === null ? FALLBACK_MESSAGE : `No symbols found matching "${params.query}"`,
            }
          }

          const limit = params.limit ?? 20
          const total = result.symbols.length
          const truncated = total > limit
          const final = truncated ? result.symbols.slice(0, limit) : result.symbols

          const output = [
            `Found ${total} symbol${total === 1 ? "" : "s"}${truncated ? ` (showing first ${limit})` : ""}`,
            "",
            ...final.map(
              (sym: { path: string; line: number; kind: string; name: string }) =>
                `${sym.path}:${sym.line} [${sym.kind}] ${sym.name}`,
            ),
          ]

          if (truncated) {
            output.push(
              "",
              `(Results truncated: showing ${limit} of ${total} symbols. Consider using a more specific query or file_pattern.)`,
            )
          }

          return {
            title: params.query,
            metadata: {
              matches: total,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
