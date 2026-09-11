import { defineConfig } from "drizzle-kit"
import path from "path"
import os from "os"

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/**/*.sql.ts",
  out: "./migration",
  dbCredentials: {
    url: path.join(os.homedir(), ".local/share/duoduo/duoduo.db"),
  },
})
