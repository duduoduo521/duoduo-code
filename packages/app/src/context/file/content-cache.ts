import type { FileContent } from "@duoduo-ai/sdk/v2"

const MAX_FILE_CONTENT_ENTRIES = 40
const MAX_FILE_CONTENT_BYTES = 20 * 1024 * 1024

class ProjectContentCache {
  readonly lru = new Map<string, number>()
  total = 0

  setBytes(path: string, nextBytes: number) {
    const prev = this.lru.get(path)
    if (prev !== undefined) this.total -= prev
    this.lru.delete(path)
    this.lru.set(path, nextBytes)
    this.total += nextBytes
  }

  touch(path: string, bytes?: number) {
    const prev = this.lru.get(path)
    if (prev === undefined && bytes === undefined) return
    this.setBytes(path, bytes ?? prev ?? 0)
  }

  remove(path: string) {
    const prev = this.lru.get(path)
    if (prev === undefined) return
    this.lru.delete(path)
    this.total -= prev
  }

  reset() {
    this.lru.clear()
    this.total = 0
  }

  evict(keep: Set<string> | undefined, evict: (path: string) => void) {
    const set = keep ?? new Set<string>()

    while (this.lru.size > MAX_FILE_CONTENT_ENTRIES || this.total > MAX_FILE_CONTENT_BYTES) {
      const path = this.lru.keys().next().value
      if (!path) return

      if (set.has(path)) {
        this.touch(path)
        if (this.lru.size <= set.size) return
        continue
      }

      this.remove(path)
      evict(path)
    }
  }
}

const projectCaches = new Map<string, ProjectContentCache>()

function getOrCreateCache(directory: string): ProjectContentCache {
  let cache = projectCaches.get(directory)
  if (!cache) {
    cache = new ProjectContentCache()
    projectCaches.set(directory, cache)
  }
  return cache
}

export function approxBytes(content: FileContent) {
  const patchBytes =
    content.patch?.hunks.reduce((sum, hunk) => {
      return sum + hunk.lines.reduce((lineSum, line) => lineSum + line.length, 0)
    }, 0) ?? 0

  return (content.content.length + (content.diff?.length ?? 0) + patchBytes) * 2
}

export function evictContentLru(directory: string, keep: Set<string> | undefined, evict: (path: string) => void) {
  const cache = projectCaches.get(directory)
  if (!cache) return
  cache.evict(keep, evict)
}

export function resetFileContentLru(directory?: string) {
  if (directory) {
    projectCaches.get(directory)?.reset()
    projectCaches.delete(directory)
  } else {
    for (const cache of projectCaches.values()) cache.reset()
    projectCaches.clear()
  }
}

export function setFileContentBytes(directory: string, path: string, bytes: number) {
  getOrCreateCache(directory).setBytes(path, bytes)
}

export function removeFileContentBytes(directory: string, path: string) {
  projectCaches.get(directory)?.remove(path)
}

export function touchFileContent(directory: string, path: string, bytes?: number) {
  getOrCreateCache(directory).touch(path, bytes)
}

export function getFileContentBytesTotal(directory: string) {
  return projectCaches.get(directory)?.total ?? 0
}

export function getFileContentEntryCount(directory: string) {
  return projectCaches.get(directory)?.lru.size ?? 0
}

export function hasFileContent(directory: string, path: string) {
  return projectCaches.get(directory)?.lru.has(path) ?? false
}
