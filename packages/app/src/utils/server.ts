import { createDuoDuoClient } from "@duoduo-ai/sdk/v2/client"
import type { ServerConnection } from "@/context/server"

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createDuoDuoClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${btoa(`${server.username ?? "duoduocode"}:${server.password}`)}`,
    }
  })()

  return createDuoDuoClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : (config.headers as Record<string, string>)),
      ...(auth as Record<string, string>),
    },
    baseUrl: server.url,
  })
}
