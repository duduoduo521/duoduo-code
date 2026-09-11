import { createClient } from "@hey-api/openapi-ts"
import { writeFileSync, rmSync, mkdirSync } from "fs"

const spec = {
  openapi: "3.0.0",
  info: { title: "Smoke", version: "1.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "getPing",
        summary: "ping",
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: { type: "object", properties: { msg: { type: "string" } } }
              }
            }
          }
        }
      }
    }
  }
}

rmSync("smoke-out", { recursive: true, force: true })
mkdirSync("smoke-out", { recursive: true })
writeFileSync("smoke-out/openapi.json", JSON.stringify(spec, null, 2))

await createClient({
  input: "smoke-out/openapi.json",
  output: { path: "smoke-out/gen", clean: true },
  plugins: [
    { name: "@hey-api/typescript" },
    { name: "@hey-api/sdk", instance: "DuoDuoClient" },
    { name: "@hey-api/client-fetch" },
  ],
})
console.log("SMOKE_OK: createClient generated client under smoke-out/gen")
