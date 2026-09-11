import { describe, expect, test } from "bun:test"
import { Context, Effect, Option } from "effect"
import { InstanceRef, WorkspaceRef } from "../../src/effect/instance-ref"

describe("effect.instance-ref", () => {
  describe("InstanceRef", () => {
    test("default value is undefined via useSync", async () => {
      const result = await Effect.runPromise(InstanceRef.useSync((v) => v))
      expect(result).toBeUndefined()
    })

    test("Effect.serviceOption returns Some with undefined value by default", async () => {
      // Context.Reference always has a default, so serviceOption is always Some
      const result = await Effect.runPromise(Effect.serviceOption(InstanceRef))
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value).toBeUndefined()
      }
    })

    test("can be provided with a value via provideService", async () => {
      const mockInstance = { directory: "/test/dir" } as any
      const result = await Effect.runPromise(
        InstanceRef.useSync((v) => v).pipe(Effect.provideService(InstanceRef, mockInstance)),
      )
      expect(result).toBe(mockInstance)
      expect(result!.directory).toBe("/test/dir")
    })

    test("can be provided with different values in parallel scopes", async () => {
      const instA = { directory: "/a" } as any
      const instB = { directory: "/b" } as any

      const [a, b] = await Effect.runPromise(
        Effect.all([
          InstanceRef.useSync((v) => v).pipe(Effect.provideService(InstanceRef, instA)),
          InstanceRef.useSync((v) => v).pipe(Effect.provideService(InstanceRef, instB)),
        ]),
      )

      expect(a!.directory).toBe("/a")
      expect(b!.directory).toBe("/b")
    })

    test("multiple provides — first provideService wins for Context.Reference", async () => {
      // Context.Reference only sets value once; the first provideService wins
      const outer = { directory: "/outer" } as any
      const inner = { directory: "/inner" } as any

      const result = await Effect.runPromise(
        InstanceRef.useSync((v) => v).pipe(
          Effect.provideService(InstanceRef, outer),
          Effect.provideService(InstanceRef, inner),
        ),
      )

      // First provideService (outer) takes effect for Reference-based services
      expect(result!.directory).toBe("/outer")
    })

    test("default value remains unchanged outside provided scope", async () => {
      const result = await Effect.runPromise(
        InstanceRef.useSync((v) => v).pipe(Effect.provideService(InstanceRef, { directory: "/scoped" } as any)),
      )

      expect(result!.directory).toBe("/scoped")

      // Outside provided scope, default is restored
      const outside = await Effect.runPromise(InstanceRef.useSync((v) => v))
      expect(outside).toBeUndefined()
    })

    test("useSync returns the service value synchronously", async () => {
      const inst = { directory: "/sync" } as any
      const result = await Effect.runPromise(
        InstanceRef.useSync((v) => v).pipe(Effect.provideService(InstanceRef, inst)),
      )
      expect(result).toBe(inst)
    })
  })

  describe("WorkspaceRef", () => {
    test("default value is undefined", async () => {
      const result = await Effect.runPromise(WorkspaceRef.useSync((v) => v))
      expect(result).toBeUndefined()
    })

    test("can be provided with a workspace ID string", async () => {
      const result = await Effect.runPromise(
        WorkspaceRef.useSync((v) => v).pipe(Effect.provideService(WorkspaceRef, "workspace-abc-123" as any)),
      )
      expect(result).toBe("workspace-abc-123" as any)
    })

    test("can be provided with different IDs in parallel scopes", async () => {
      const [a, b] = await Effect.runPromise(
        Effect.all([
          WorkspaceRef.useSync((v) => v).pipe(Effect.provideService(WorkspaceRef, "ws-1" as any)),
          WorkspaceRef.useSync((v) => v).pipe(Effect.provideService(WorkspaceRef, "ws-2" as any)),
        ]),
      )

      expect(a).toBe("ws-1" as any)
      expect(b).toBe("ws-2" as any)
    })

    test("returns a string when provided", async () => {
      const result = await Effect.runPromise(
        WorkspaceRef.useSync((v) => v).pipe(Effect.provideService(WorkspaceRef, "workspace-xyz" as any)),
      )
      expect(typeof result).toBe("string")
      expect(result).toBe("workspace-xyz" as any)
    })

    test("scoped provide does not leak to other effects", async () => {
      const result = await Effect.runPromise(
        Effect.all([
          WorkspaceRef.useSync((v) => v).pipe(Effect.provideService(WorkspaceRef, "scoped-1" as any)),
          WorkspaceRef.useSync((v) => v).pipe(Effect.provideService(WorkspaceRef, "scoped-2" as any)),
        ]),
      )

      expect(result).toEqual(["scoped-1" as any, "scoped-2" as any])

      // Outside all scopes, default still applies
      const outside = await Effect.runPromise(WorkspaceRef.useSync((v) => v))
      expect(outside).toBeUndefined()
    })

    test("can provide via explicit Context", async () => {
      const ctx = Context.make(WorkspaceRef, "from-context" as any)
      const result = await Effect.runPromise(WorkspaceRef.useSync((v) => v).pipe(Effect.provideContext(ctx)))
      expect(result).toBe("from-context" as any)
    })
  })
})
