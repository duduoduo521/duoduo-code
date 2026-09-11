import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { resolveNetworkOptionsNoConfig } from "../network"
import { Flag } from "../../flag/flag"

export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) =>
    yargs
      .option("port", {
        type: "number" as const,
        describe: "port to listen on",
        default: 0,
      })
      .option("hostname", {
        type: "string" as const,
        describe: "hostname to listen on",
        default: "127.0.0.1",
      })
      .option("directory", {
        type: "string" as const,
        describe: "fixed working directory",
      }),
  describe: "starts a headless duoduo server",
  handler: async (args) => {
    if (args.directory) {
      process.env.DUODUO_FIXED_DIRECTORY = args.directory
      console.log(`Fixed project directory: ${args.directory}`)
    }
    if (!Flag.DUODUO_SERVER_PASSWORD) {
      console.log("Warning: DUODUO_SERVER_PASSWORD is not set; server is unsecured.")
    }
    // Prefer DUODUO_PORT env var (set by desktop sidecar spawner) over CLI flag.
    // serve runs without bootstrap, so Config.Service is unavailable at startup —
    // use resolveNetworkOptionsNoConfig instead of resolveNetworkOptions.
    const port = Number(process.env.DUODUO_PORT) || args.port || 0
    const opts = resolveNetworkOptionsNoConfig({
      port,
      hostname: args.hostname,
      mdns: false,
      "mdns-domain": "duoduo.local",
      cors: [],
    })
    const server = await Server.listen(opts)
    console.log(`duoduo server listening on http://${server.hostname}:${server.port}`)

    await new Promise<void>((resolve) => {
      const handler = () => {
        process.off("SIGINT", handler)
        process.off("SIGTERM", handler)
        resolve()
      }
      process.on("SIGINT", handler)
      process.on("SIGTERM", handler)
    })
    await server.stop()
  },
})
