import { defineConfig, devices } from "@playwright/test"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`
const reuse = process.env.PLAYWRIGHT_REUSE_SERVER === "1"
const workers = Number(process.env.PLAYWRIGHT_WORKERS ?? (process.env.CI ? 5 : 3)) || undefined
const reporter: NonNullable<Parameters<typeof defineConfig>[0]["reporter"]> = [
  ["html", { outputFolder: "e2e/playwright-report", open: "never" }],
  ["line"],
]

if (process.env.PLAYWRIGHT_JUNIT_OUTPUT) {
  reporter.push(["junit", { outputFile: process.env.PLAYWRIGHT_JUNIT_OUTPUT }])
}

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/test-results",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers,
  reporter,
  globalSetup: resolve(__dirname, "e2e/helpers/global-setup.ts"),
  globalTeardown: resolve(__dirname, "e2e/helpers/global-teardown.ts"),
  webServer: {
    // The dev-server wrapper starts: mock LLM → isolated backend → Vite dev server
    // It writes runtime info (backend URL, project dir) to .runtime-info.json
    // that test helpers read to connect to the isolated backend.
    command: `bun run ${resolve(__dirname, "e2e/helpers/dev-server.ts")} --port ${port}`,
    url: baseURL,
    reuseExistingServer: reuse,
    timeout: 180_000,
  },
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
})
