// IntelGear sample plugin — `echo` tool.
//
// Demonstrates the canonical server() protocol (see SDK.md). Load this from a
// host with: { method: "load", params: { spec: "<path>/echo.mjs", kind: "server" } }
export default {
  server() {
    return {
      listTools: async () => ({
        tools: [
          {
            name: "echo",
            description: "Echo back the provided message.",
            inputSchema: {
              type: "object",
              properties: {
                msg: { type: "string", description: "Message to echo back" },
              },
              required: ["msg"],
            },
          },
        ],
      }),
      callTool: async ({ name, arguments: args }) => {
        if (name !== "echo") throw new Error(`unknown tool ${name}`)
        const text = `ECHO:${args?.msg ?? ""}`
        return { content: [{ type: "text", text }] }
      },
    }
  },
}
