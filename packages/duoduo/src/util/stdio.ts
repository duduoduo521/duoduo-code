/**
 * Safe stdout writer.
 *
 * When stdout is piped (e.g. `duoduo run ... | head`), the downstream consumer
 * may close early and trigger EPIPE on writes. Without handling, Node/Bun throw
 * an uncaught error and the process crashes. A closed pipe is a normal
 * termination signal, so we swallow EPIPE and return false instead.
 */
export function writeStdout(chunk: string): boolean {
  try {
    return process.stdout.write(chunk)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EPIPE") return false
    throw err
  }
}
