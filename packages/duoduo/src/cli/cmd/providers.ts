import { Auth } from "../../auth"
import { AppRuntime } from "../../effect/app-runtime"
import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Provider } from "../../provider"
import { map, pipe, sortBy, values } from "remeda"
import path from "path"
import os from "os"
import { Config } from "../../config"
import { Global } from "../../global"
import { Instance } from "../../project/instance"
import type { Hooks } from "@duoduo-ai/plugin"
import { Process } from "../../util"
import { text } from "node:stream/consumers"
import { Effect } from "effect"
import { createSmartLayerClients } from "@/smart-layer"

const put = (key: string, info: Auth.Info) =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set(key, info)
    }),
  )

export function resolvePluginProviders(input: {
  hooks?: Hooks[]
  existingProviders: Record<string, unknown>
  disabled: Set<string>
  enabled?: Set<string>
  providerNames: Record<string, string | undefined>
}): Array<{ id: string; name: string }> {
  const seen = new Set<string>()
  const result: Array<{ id: string; name: string }> = []

  for (const hook of input.hooks ?? []) {
    if (!hook.auth) continue
    const id = hook.auth.provider
    if (seen.has(id)) continue
    seen.add(id)
    if (Object.hasOwn(input.existingProviders, id)) continue
    if (input.disabled.has(id)) continue
    if (input.enabled && !input.enabled.has(id)) continue
    result.push({
      id,
      name: input.providerNames[id] ?? id,
    })
  }

  return result
}

export const ProvidersCommand = cmd({
  command: "providers",
  aliases: ["auth"],
  describe: "manage AI providers and credentials",
  builder: (yargs) =>
    yargs.command(ProvidersListCommand).command(ProvidersLoginCommand).command(ProvidersLogoutCommand).demandCommand(),
  async handler() {},
})

export const ProvidersListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list providers and credentials",
  async handler(_args) {
    UI.empty()
    const authPath = path.join(Global.Path.data, "auth.json")
    const homedir = os.homedir()
    const displayPath = authPath.startsWith(homedir) ? authPath.replace(homedir, "~") : authPath
    prompts.intro(`Credentials ${UI.Style.TEXT_DIM}${displayPath}`)
    const results = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        return Object.entries(yield* auth.all())
      }),
    )

    // Get runtime providers from Provider.Service
    const providers = (await AppRuntime.runPromise(
      Effect.gen(function* () {
        const svc = yield* Provider.Service
        return yield* svc.list()
      }),
    )) as Record<string, Provider.Info>

    for (const [providerID, result] of results) {
      const name = providers[providerID]?.name || providerID
      prompts.log.info(`${name} ${UI.Style.TEXT_DIM}${result.type}`)
    }

    prompts.outro(`${results.length} credentials`)

    const activeEnvVars: Array<{ provider: string; envVar: string }> = []

    for (const [providerID, provider] of Object.entries(providers)) {
      for (const envVar of provider.env) {
        if (process.env[envVar]) {
          activeEnvVars.push({
            provider: provider.name || providerID,
            envVar,
          })
        }
      }
    }

    if (activeEnvVars.length > 0) {
      UI.empty()
      prompts.intro("Environment")

      for (const { provider, envVar } of activeEnvVars) {
        prompts.log.info(`${provider} ${UI.Style.TEXT_DIM}${envVar}`)
      }

      prompts.outro(`${activeEnvVars.length} environment variable` + (activeEnvVars.length === 1 ? "" : "s"))
    }
  },
})

export const ProvidersLoginCommand = cmd({
  command: "login [url]",
  describe: "log in to a provider",
  builder: (yargs) =>
    yargs
      .positional("url", {
        describe: "duoduo-ai auth provider",
        type: "string",
      })
      .option("provider", {
        alias: ["p"],
        describe: "provider id or name to log in to (skips provider selection)",
        type: "string",
      })
      .option("method", {
        alias: ["m"],
        describe: "login method label (skips method selection)",
        type: "string",
      }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        UI.empty()
        prompts.intro("Add credential")
        if (args.url) {
          const url = args.url.replace(/\/+$/, "")
          const response = await fetch(`${url}/.well-known/duoduo`)
          if (!response.ok) {
            prompts.log.error(`Failed to fetch .well-known/duoduo: ${response.status} ${response.statusText}`)
            process.exitCode = 1
            prompts.outro("Done")
            return
          }
          const wellknown = (await response.json()) as {
            auth: { command: string[]; env: string }
          }
          prompts.log.info(`Running \`${wellknown.auth.command.join(" ")}\``)
          const proc = Process.spawn(wellknown.auth.command, {
            stdout: "pipe",
          })
          if (!proc.stdout) {
            prompts.log.error("Failed")
            process.exitCode = 1
            prompts.outro("Done")
            return
          }
          const [exit, token] = await Promise.all([proc.exited, text(proc.stdout)])
          if (exit !== 0) {
            prompts.log.error("Failed")
            process.exitCode = 1
            prompts.outro("Done")
            return
          }
          await put(url, {
            type: "wellknown",
            key: wellknown.auth.env,
            token: token.trim(),
          })
          prompts.log.success("Logged into " + url)
          prompts.outro("Done")
          return
        }
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const svc = yield* Provider.Service
            yield* svc.list() // trigger provider initialization
          }),
        )

        const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.get()))

        const disabled = new Set(config.disabled_providers ?? [])
        const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

        const providers = (await AppRuntime.runPromise(
          Effect.gen(function* () {
            const svc = yield* Provider.Service
            return yield* svc.list()
          }),
        )) as Record<string, Provider.Info>
        const filteredProviders: Record<string, Provider.Info> = {}
        for (const [key, value] of Object.entries(providers)) {
          if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
            filteredProviders[key] = value
          }
        }

        const priority: Record<string, number> = {}
        const pluginProviders = resolvePluginProviders({
          existingProviders: filteredProviders,
          disabled,
          enabled,
          providerNames: Object.fromEntries(Object.entries(config.provider ?? {}).map(([id, p]) => [id, p.name])),
        })
        const options = [
          ...pipe(
            filteredProviders,
            values(),
            sortBy(
              (x) => priority[x.id] ?? 99,
              (x) => x.name ?? x.id,
            ),
            map((x) => ({
              label: x.name,
              value: x.id,
              hint: undefined,
            })),
          ),
          ...pluginProviders.map((x) => ({
            label: x.name,
            value: x.id,
            hint: "plugin",
          })),
        ]

        let provider: string
        if (args.provider) {
          const input = args.provider
          const byID = options.find((x) => x.value === input)
          const byName = options.find((x) => x.label.toLowerCase() === input.toLowerCase())
          const match = byID ?? byName
          if (!match) {
            prompts.log.error(`Unknown provider "${input}"`)
            process.exitCode = 1
            process.exit(1)
          }
          provider = match.value
        } else {
          const selected = await prompts.autocomplete({
            message: "Select provider",
            maxItems: 8,
            options: [
              ...options,
              {
                value: "other",
                label: "Other",
              },
            ],
          })
          if (prompts.isCancel(selected)) throw new UI.CancelledError()
          provider = selected
        }

        if (provider === "other") {
          const custom = await prompts.text({
            message: "Enter provider id",
            validate: (x) => (x && x.match(/^[0-9a-z-]+$/) ? undefined : "a-z, 0-9 and hyphens only"),
          })
          if (prompts.isCancel(custom)) throw new UI.CancelledError()
          provider = custom.replace(/^@ai-sdk\//, "")

          prompts.log.warn(
            `This only stores a credential for ${provider} - you will need configure it in duoduo-ai.json, check the docs for examples.`,
          )
        }

        const key = await prompts.password({
          message: "Enter your API key",
          validate: (x) => (x && x.length > 0 ? undefined : "Required"),
        })
        if (prompts.isCancel(key)) throw new UI.CancelledError()
        await put(provider, {
          type: "api",
          key,
        })

        prompts.outro("Done")
      },
    })
  },
})

export const ProvidersLogoutCommand = cmd({
  command: "logout",
  describe: "log out from a configured provider",
  async handler(_args) {
    UI.empty()
    const credentials: Array<[string, Auth.Info]> = await AppRuntime.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        return Object.entries(yield* auth.all())
      }),
    )
    prompts.intro("Remove credential")
    if (credentials.length === 0) {
      prompts.log.error("No credentials found")
      return
    }
    // Get runtime providers from Provider.Service
    const providers = (await AppRuntime.runPromise(
      Effect.gen(function* () {
        const svc = yield* Provider.Service
        return yield* svc.list()
      }),
    )) as Record<string, Provider.Info>
    const selected = await prompts.select({
      message: "Select provider",
      options: credentials.map(([key, value]) => ({
        label: (providers[key]?.name || key) + UI.Style.TEXT_DIM + " (" + value.type + ")",
        value: key,
      })),
    })
    if (prompts.isCancel(selected)) throw new UI.CancelledError()
    const providerID = selected
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.remove(providerID)
      }),
    )
    // Instant keyring purge: remove the OS keyring entry for this provider
    // immediately. Fire-and-forget + best-effort — the Rust side's startup
    // orphan-sweep is the backstop if the smart layer is unavailable.
    const sl = createSmartLayerClients()
    if (sl) {
      sl.agent
        .keyringDelete(providerID)
        .catch((e: unknown) =>
          console.warn("[providers logout] keyring purge failed (non-fatal):", e),
        )
    }
    prompts.outro("Logout successful")
  },
})
