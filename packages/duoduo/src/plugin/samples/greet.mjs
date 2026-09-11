// IntelGear sample plugin — `greet` + `farewell` tools.
//
// Demonstrates a multi-tool plugin with per-tool inputSchema (see SDK.md).
export default {
  server() {
    return {
      listTools: async () => ({
        tools: [
          {
            name: "greet",
            description: "Greet a person by name, optionally in uppercase.",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Who to greet" },
                loud: { type: "boolean", description: "Shout the greeting" },
              },
              required: ["name"],
            },
          },
          {
            name: "farewell",
            description: "Say goodbye to a person.",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Who to say goodbye to" },
              },
              required: ["name"],
            },
          },
        ],
      }),
      callTool: async ({ name, arguments: args }) => {
        const who = args?.name ?? "world"
        let text
        if (name === "greet") {
          text = args?.loud ? `HELLO, ${who.toUpperCase()}!` : `Hello, ${who}.`
        } else if (name === "farewell") {
          text = `Goodbye, ${who}.`
        } else {
          throw new Error(`unknown tool ${name}`)
        }
        return { content: [{ type: "text", text }] }
      },
    }
  },
}
