import { test, expect } from "bun:test"
import { Effect } from "effect"
import { createRequire } from "module"
import path from "path"
import { pathToFileURL } from "node:url"
import { MCP } from "../../src/mcp/index"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { APP_CONFIG_SCHEMA } from "../../src/config/domains"

// Resolve the official MCP SDK to file:// URLs so the spawned (offline)
// Windows server can import it regardless of cwd / node_modules resolution.
const require = createRequire(import.meta.url)
const SDK_SERVER = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/index.js")).href
const SDK_STDIO = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/server/stdio.js")).href
const SDK_TYPES = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/types.js")).href

// A real MCP server speaking the real protocol over stdio, built with the
// official SDK — not a mock. It exposes one tool, `real_greet`.
const SERVER_SRC = `
import { Server } from "${SDK_SERVER}"
import { StdioServerTransport } from "${SDK_STDIO}"
import { ListToolsRequestSchema, CallToolRequestSchema } from "${SDK_TYPES}"

const server = new Server(
  { name: "real-test-server", version: "1.0.0" },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "real_greet",
      description: "Greet someone by name.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.arguments?.name ?? "world"
  return { content: [{ type: "text", text: "HELLO:" + name }] }
})

const transport = new StdioServerTransport()
await server.connect(transport)
`

test("real MCP server e2e through McpAdapter (connectLocal + stdio)", async () => {
  let serverPath = ""
  await using tmp = await tmpdir({
    init: async (dir) => {
      serverPath = path.join(dir, "real-mcp-server.mjs")
      await Bun.write(serverPath, SERVER_SRC)
      // Register the server in config so the MCP Service `init` connects it
      // for real (spawning the server subprocess) before our assertions run.
      await Bun.write(
        `${dir}/duoduo-ai.json`,
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          mcp: {
            "real-server": { type: "local", enabled: true, command: ["node", serverPath] },
          },
        }),
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Effect.runPromise(
        MCP.Service.use((mcp) =>
          Effect.gen(function* () {
            const status = yield* mcp.status()
            expect(status["real-server"]?.status).toBe("connected")

            // listTools from the real (spawned) connection
            const tools = yield* mcp.tools()
            const key = Object.keys(tools).find((k) => k.includes("real_greet"))
            expect(key).toBeDefined()
            expect(key).toContain("real-server")

            // real callTool over the spawned connection
            const clients = yield* mcp.clients()
            const client = clients["real-server"]
            expect(client).toBeDefined()
            const res = yield* Effect.promise(() =>
              client.callTool({ name: "real_greet", arguments: { name: "zed" } }),
            )
            const text = (res.content as Array<{ type: string; text?: string }>)
              .map((c) => c.text ?? "")
              .join("")
            expect(text).toBe("HELLO:zed")
          }),
        ).pipe(Effect.provide(MCP.defaultLayer)),
      )
      await Instance.dispose()
    },
  })
})
