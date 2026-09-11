import type { Argv, InferredOptionTypes } from "yargs"
import { Config } from "../config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "../flag/flag"

const options = {
  port: {
    type: "number" as const,
    describe: "port to listen on",
    default: 0,
  },
  hostname: {
    type: "string" as const,
    describe: "hostname to listen on",
    default: "127.0.0.1",
  },
  mdns: {
    type: "boolean" as const,
    describe: "enable mDNS service discovery (defaults hostname to 0.0.0.0)",
    default: false,
  },
  "mdns-domain": {
    type: "string" as const,
    describe: "custom domain name for mDNS service (default: duoduo.local)",
    default: "duoduo.local",
  },
  cors: {
    type: "string" as const,
    array: true,
    describe: "additional domains to allow for CORS",
    default: [] as string[],
  },
}

export type NetworkOptions = InferredOptionTypes<typeof options>

export function withNetworkOptions<T>(yargs: Argv<T>) {
  return yargs.options(options)
}
export async function resolveNetworkOptions(args: NetworkOptions) {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  return resolveNetworkOptionsNoConfig(args, config)
}

export function resolveNetworkOptionsNoConfig(args: NetworkOptions, config?: Config.Info) {
  const portExplicitlySet = process.argv.some(a => a === "--port" || a.startsWith("--port="))
  const hostnameExplicitlySet = process.argv.some(a => a === "--hostname" || a.startsWith("--hostname="))
  const mdnsExplicitlySet = process.argv.some(a => a === "--mdns" || a.startsWith("--mdns="))
  const mdnsDomainExplicitlySet = process.argv.some(a => a === "--mdns-domain" || a.startsWith("--mdns-domain="))
  const mdns = mdnsExplicitlySet ? args.mdns : (config?.server?.mdns ?? args.mdns)
  const mdnsDomain = mdnsDomainExplicitlySet ? args["mdns-domain"] : (config?.server?.mdnsDomain ?? args["mdns-domain"])
  const port = portExplicitlySet ? args.port : (config?.server?.port ?? args.port)
  const hostname = hostnameExplicitlySet
    ? args.hostname
    : mdns && !config?.server?.hostname
      ? "0.0.0.0"
      : (config?.server?.hostname ?? args.hostname)
  const configCors = config?.server?.cors ?? []
  const argsCors = Array.isArray(args.cors) ? args.cors : args.cors ? [args.cors] : []
  const cors = [...configCors, ...argsCors]

  // Security: binding beyond loopback (or publishing via mDNS) exposes every
  // route — including command execution and file writes — to the local network.
  // AuthMiddleware only enforces credentials when DUODUO_SERVER_PASSWORD is set,
  // so refuse to start instead of silently exposing an unauthenticated server.
  const loopback = hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.")
  if ((mdns || !loopback) && !Flag.DUODUO_SERVER_PASSWORD) {
    throw new Error(
      `Refusing to listen on ${hostname}${mdns ? " with mDNS enabled" : ""} without a password. ` +
        `Set DUODUO_SERVER_PASSWORD, or bind to a loopback address such as 127.0.0.1.`,
    )
  }

  return { hostname, port, mdns, mdnsDomain, cors }
}
