/**
 * Minimal MCP stdio server for E2E tests (scenario g: gear MCP tool round-trip).
 *
 * Speaks newline-delimited JSON-RPC over stdin/stdout (the MCP stdio
 * transport, hand-rolled on the Rust side in agent-executor/src/mcp.rs):
 *   initialize → notifications/initialized → tools/list → tools/call.
 *
 * Exposes one tool, `echo`, which answers `echo:<text>` so the E2E spec can
 * assert the exact round-trip: LLM tool call → Rust MCP dispatch → this
 * server → tool result back into the conversation.
 */
import { createInterface } from "node:readline"

const SERVER_INFO = { name: "e2e-echo-server", version: "1.0.0" }

const TOOLS = [
  {
    name: "echo",
    description: "Echo back the provided text (E2E marker tool)",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo" } },
      required: ["text"],
    },
  },
]

function respond(id: unknown, result: unknown) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n",
  )
}

const rl = createInterface({ input: process.stdin })
rl.on("line", (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg: any
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  const { id, method, params } = msg ?? {}

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
      break
    case "tools/list":
      respond(id, { tools: TOOLS })
      break
    case "tools/call": {
      const text = params?.arguments?.text ?? ""
      if (typeof text !== "string" || text.length === 0) {
        respond(id, {
          content: [{ type: "text", text: "echo: missing `text` argument" }],
          isError: true,
        })
        break
      }
      respond(id, {
        content: [{ type: "text", text: `echo:${text}` }],
        isError: false,
      })
      break
    }
    default:
      // notifications (no id) and unknown methods are ignored.
      if (id !== undefined && id !== null) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `method not found: ${method}` },
          }) + "\n",
        )
      }
  }
})
