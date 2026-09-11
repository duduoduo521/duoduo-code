import { afterEach, test, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { provideInstance, tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Config } from "../../src/config"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Color } from "../../src/util"
import { AppRuntime } from "../../src/effect/app-runtime"
import { APP_CONFIG_SCHEMA } from "../../src/config/domains"

const load = () => AppRuntime.runPromise(Config.Service.use((svc) => svc.get()))
const agent = <A>(dir: string, fn: (svc: AgentSvc.Interface) => Effect.Effect<A, unknown, unknown>) => {
  const effect = provideInstance(dir)(AgentSvc.Service.use(fn)).pipe(Effect.provide(AgentSvc.defaultLayer))
  return Effect.runPromise(effect as Effect.Effect<A, unknown, never>)
}

import { disposeAllWithTimeout } from "../lib/dispose"

afterEach(async () => {
  await disposeAllWithTimeout()
})

test("agent color parsed from project config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          agent: {
            build: { color: "#FFA500" },
            plan: { color: "primary" },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cfg = await load()
      expect(cfg.agent?.["build"]?.color).toBe("#FFA500")
      expect(cfg.agent?.["plan"]?.color).toBe("primary")
    },
  })
})

test("Agent.get includes color from config", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await Bun.write(
        path.join(dir, "duoduo.json"),
        JSON.stringify({
          $schema: APP_CONFIG_SCHEMA,
          agent: {
            plan: { color: "#A855F7" },
            build: { color: "accent" },
          },
        }),
      )
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const { plan, build } = await agent(tmp.path, (svc) =>
        Effect.gen(function* () {
          return {
            plan: yield* svc.get("plan"),
            build: yield* svc.get("build"),
          }
        }),
      )
      expect(plan?.color).toBe("#A855F7")
      expect(build?.color).toBe("accent")
    },
  })
})

test("Color.hexToAnsiBold converts valid hex to ANSI", () => {
  const result = Color.hexToAnsiBold("#FFA500")
  expect(result).toBe("\x1b[38;2;255;165;0m\x1b[1m")
})

test("Color.hexToAnsiBold returns undefined for invalid hex", () => {
  expect(Color.hexToAnsiBold(undefined)).toBeUndefined()
  expect(Color.hexToAnsiBold("")).toBeUndefined()
  expect(Color.hexToAnsiBold("#FFF")).toBeUndefined()
  expect(Color.hexToAnsiBold("FFA500")).toBeUndefined()
  expect(Color.hexToAnsiBold("#GGGGGG")).toBeUndefined()
})
