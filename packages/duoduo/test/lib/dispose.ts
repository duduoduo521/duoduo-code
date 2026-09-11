import { Instance } from "../../src/project/instance"

/**
 * Dispose all instances with a timeout guard.
 *
 * In `--isolate --max-concurrency=1` mode, Effect fiber leaks can cause
 * `Instance.disposeAll()` to hang indefinitely, which exceeds bun's 3-second
 * afterEach time-window and triggers cascading hook timeouts in subsequent tests.
 *
 * This wrapper races `disposeAll()` against a configurable timeout (default 10s)
 * so a single slow disposal never cascades into mass test failures.
 */
export async function disposeAllWithTimeout(timeoutMs = 10_000): Promise<void> {
  await Promise.race([
    Instance.disposeAll(),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}
