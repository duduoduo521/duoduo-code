import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Env } from "../../src/env"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Env.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("Env", () => {
  it.live("get returns existing env key", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const env = yield* Env.Service
        // `Env.get` reads the in-memory snapshot seeded from `{ ...process.env }`.
        // On Windows `process.env` is case-normalized to upper-case keys, so the
        // snapshot only contains "PATH" (not "Path"). Use "PATH" on every platform —
        // it is always present and the snapshot seed preserves the upper-case key.
        const key = "PATH"
        const value = yield* env.get(key)
        expect(value).toBeDefined()
        expect(typeof value).toBe("string")
      }),
    ),
  )

  it.live("get returns undefined for missing key", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const env = yield* Env.Service
        const value = yield* env.get("DUODUO_NONEXISTENT_KEY_XYZ")
        expect(value).toBeUndefined()
      }),
    ),
  )

  it.live("all returns the full env object", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const env = yield* Env.Service
        const all = yield* env.all()
        expect(typeof all).toBe("object")
        expect(all).not.toBeNull()
        // Should have at least some keys from process.env
        expect(Object.keys(all).length).toBeGreaterThan(0)
      }),
    ),
  )

  it.live("set adds a new key", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const env = yield* Env.Service
        yield* env.set("DUODUO_TEST_NEW_KEY", "test-value")
        const value = yield* env.get("DUODUO_TEST_NEW_KEY")
        expect(value).toBe("test-value")
      }),
    ),
  )

  it.live("set updates an existing key", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const env = yield* Env.Service
        yield* env.set("DUODUO_TEST_UPDATE_KEY", "initial")
        const before = yield* env.get("DUODUO_TEST_UPDATE_KEY")
        expect(before).toBe("initial")

        yield* env.set("DUODUO_TEST_UPDATE_KEY", "updated")
        const after = yield* env.get("DUODUO_TEST_UPDATE_KEY")
        expect(after).toBe("updated")
      }),
    ),
  )

  it.live("remove deletes a key", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const env = yield* Env.Service
        yield* env.set("DUODUO_TEST_REMOVE_KEY", "to-be-removed")
        const before = yield* env.get("DUODUO_TEST_REMOVE_KEY")
        expect(before).toBe("to-be-removed")

        yield* env.remove("DUODUO_TEST_REMOVE_KEY")
        const after = yield* env.get("DUODUO_TEST_REMOVE_KEY")
        expect(after).toBeUndefined()
      }),
    ),
  )

  it.live("remove is a no-op for missing keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const env = yield* Env.Service
        // Should not throw when removing a key that doesn't exist
        yield* env.remove("DUODUO_TEST_MISSING_KEY")
        const value = yield* env.get("DUODUO_TEST_MISSING_KEY")
        expect(value).toBeUndefined()
      }),
    ),
  )

  it.live("set writes through to process.env and remove cleans it", () =>
    Effect.gen(function* () {
      // Set a key in first instance — writes through to process.env
      yield* provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const env = yield* Env.Service
          yield* env.set("DUODUO_TEST_ISOLATION", "instance-a")
          const value = yield* env.get("DUODUO_TEST_ISOLATION")
          expect(value).toBe("instance-a")
        }),
      )

      // Second instance initializes from process.env, so it sees the key
      // (write-through is intentional for provider credential lookups).
      yield* provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const env = yield* Env.Service
          const value = yield* env.get("DUODUO_TEST_ISOLATION")
          expect(value).toBe("instance-a")

          // remove cleans both instance state and process.env
          yield* env.remove("DUODUO_TEST_ISOLATION")
          const after = yield* env.get("DUODUO_TEST_ISOLATION")
          expect(after).toBeUndefined()
        }),
      )

      // After remove, a third instance should not see the key
      yield* provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const env = yield* Env.Service
          const value = yield* env.get("DUODUO_TEST_ISOLATION")
          expect(value).toBeUndefined()
        }),
      )
    }),
  )
})
