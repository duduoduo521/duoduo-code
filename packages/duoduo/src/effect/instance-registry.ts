const disposers = new Set<(directory: string, projectId?: string) => Promise<void>>()

export function registerDisposer(disposer: (directory: string, projectId?: string) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

/**
 * Background work started by `InstanceBootstrap` that must be stopped when the
 * instance goes away.
 *
 * `InstanceBootstrap` starts long-running work (notably the knowledge-graph
 * indexing pass) with `Effect.forkDetach`. A detached fiber deliberately
 * outlives the scope that created it, so disposing the instance did NOT stop
 * it: closing a project left a full indexing run burning CPU, and — because it
 * finishes by writing a snapshot — it could resurrect an index the user had
 * just asked to clear. Registering the fiber's canceller here lets
 * `disposeInstance` interrupt it, which is the only way to actually stop
 * detached work.
 *
 * Keyed by directory so disposing one project never cancels another's work.
 * Multiple cancellers per directory are supported (a re-boot may register a
 * new one before the old entry is cleared).
 */
const cancellers = new Map<string, Set<() => Promise<void>>>()

export function registerInstanceCanceller(directory: string, cancel: () => Promise<void>) {
  let set = cancellers.get(directory)
  if (!set) {
    set = new Set()
    cancellers.set(directory, set)
  }
  set.add(cancel)
  return () => {
    const current = cancellers.get(directory)
    if (!current) return
    current.delete(cancel)
    if (current.size === 0) cancellers.delete(directory)
  }
}

export async function disposeInstance(directory: string, projectId?: string) {
  // Interrupt detached background work FIRST, then run the disposers. Ordering
  // matters: the knowledge-graph disposer clears the project's in-memory graph,
  // and letting a still-running indexing pass repopulate it afterwards would
  // leak exactly the memory the disposer exists to free.
  const pending = cancellers.get(directory)
  if (pending) {
    cancellers.delete(directory)
    await Promise.allSettled([...pending].map((cancel) => cancel()))
  }
  await Promise.allSettled([...disposers].map((disposer) => disposer(directory, projectId)))
}
