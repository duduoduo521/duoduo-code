/**
 * Manual smoke test for backend.ts — run via:
 *   bun run e2e/helpers/backend.smoke.ts
 *
 * Spins up: mock LLM + isolated backend, verifies endpoints, tears down.
 * Not part of the playwright suite; for local debugging only.
 */
import { startMockLLM } from "../mock-llm/server"
import { startIsolatedBackend, encodeProjectPath } from "./backend"

async function main() {
  console.log("[smoke] starting mock LLM…")
  const mock = await startMockLLM(0) // 0 = pick free
  console.log(`[smoke] mock LLM at ${mock.url}`)

  console.log("[smoke] starting isolated backend…")
  const backend = await startIsolatedBackend({ mockLlmUrl: mock.url })
  console.log(`[smoke] backend at ${backend.url}`)
  console.log(`[smoke] project at ${backend.projectDir}`)

  try {
    const docs = await fetch(`${backend.url}/doc`).then((r) => r.json() as Promise<{ paths: Record<string, unknown> }>)
    console.log(`[smoke] backend exposes ${Object.keys(docs.paths).length} paths`)

    // List providers — should include "mock".
    const providers = await fetch(`${backend.url}/config/provider`).then((r) =>
      r.json() as Promise<{ providers?: Record<string, unknown> }>,
    )
    console.log("[smoke] providers:", Object.keys(providers.providers ?? providers))

    // Encode the project path to verify URL encoding helper.
    const encoded = encodeProjectPath(backend.projectDir)
    console.log(`[smoke] encoded project path: ${encoded}`)
  } finally {
    console.log("[smoke] tearing down…")
    await backend.stop()
    await mock.stop()
    console.log("[smoke] done")
  }
}

main().catch((err) => {
  console.error("[smoke] failed:", err)
  process.exit(1)
})
