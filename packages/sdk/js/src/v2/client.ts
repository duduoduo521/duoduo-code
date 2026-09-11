export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { DuoDuoClient } from "./gen/sdk.gen.js"

export type DuoDuoClientConfig = Config
export type { DuoDuoClient }

function pick(value: string | null, fallback?: string, encode?: (value: string) => string) {
  if (!value) return
  if (!fallback) return value
  if (value === fallback) return fallback
  if (encode && value === encode(fallback)) return fallback
  return value
}

function rewrite(request: Request, values: { directory?: string; workspace?: string }) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const url = new URL(request.url)
  let changed = false

  for (const [headerName, key] of [
    ["x-duoduo-directory", "directory"],
    ["x-duoduo-workspace", "workspace"],
  ] as const) {
    const value = pick(
      request.headers.get(headerName),
      key === "directory" ? values.directory : values.workspace,
      key === "directory" ? encodeURIComponent : undefined,
    )
    if (!value) continue
    if (!url.searchParams.has(key)) {
      url.searchParams.set(key, value)
    }
    changed = true
  }

  if (!changed) return request

  const next = new Request(url, request)
  next.headers.delete("x-duoduo-directory")
  next.headers.delete("x-duoduo-workspace")
  return next
}

export function createDuoDuoClient(config?: Config & { directory?: string; experimental_workspaceID?: string }) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = 30000 // 30秒超时，防止请求无限挂起
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    config.headers = {
      ...(config.headers as Record<string, string>),
      "x-duoduo-directory": encodeURIComponent(config.directory),
    }
  }

  if (config?.experimental_workspaceID) {
    config.headers = {
      ...(config.headers as Record<string, string>),
      "x-duoduo-workspace": config.experimental_workspaceID,
    }
  }

  const client = createClient({ ...config, throwOnError: true } as Config)
  client.interceptors.request.use((request) =>
    rewrite(request, {
      directory: config?.directory,
      workspace: config?.experimental_workspaceID,
    }),
  )
  client.interceptors.response.use((response) => {
    const contentType = response.headers.get("content-type")
    if (contentType === "text/html")
      throw new Error("Request is not supported by this version of DuoDuoCode Server (Server responded with text/html)")

    return response
  })
  return new DuoDuoClient({ client })
}
