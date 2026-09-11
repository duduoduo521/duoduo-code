import { useGlobalSync } from "@/context/global-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"

// 预设提供商已移除，只保留自定义和本地模型
export const popularProviders: string[] = []

export function useProviders() {
  let globalSync: ReturnType<typeof useGlobalSync>
  try {
    globalSync = useGlobalSync()
  } catch {
    // GlobalSyncProvider context not yet available during initial render
    // (deeply nested createSimpleContext + gate timing). Return empty
    // fallback so ModelsProvider can render without crashing.
    return {
      all: () => [],
      default: () => ({} as Record<string, string>),
      popular: () => [],
      connected: () => [],
      paid: () => [],
    }
  }

  const params = useParams()
  const dir = createMemo(() => decode64(params.dir) ?? "")
  const providers = () => {
    if (dir()) {
      const [projectStore] = globalSync.child(dir())
      if (projectStore.provider_ready) return projectStore.provider
    }
    return globalSync.data.provider
  }
  return {
    all: () => providers().all,
    default: () => providers().default,
    popular: () => providers().all.filter(() => false),
    connected: () => {
      const connected = new Set(providers().connected)
      return providers().all.filter((p) => p.id !== "duoduocode" && connected.has(p.id))
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return providers().all.filter((p) => p.id !== "duoduocode" && connected.has(p.id))
    },
  }
}
