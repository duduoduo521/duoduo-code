export * from "./client.js"
export * from "./server.js"

import { createDuoDuoClient } from "./client.js"
import { createDuoDuoServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export * as data from "./data.js"

export async function createDuoDuo(options?: ServerOptions) {
  const server = await createDuoDuoServer({
    ...options,
  })

  const client = createDuoDuoClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
