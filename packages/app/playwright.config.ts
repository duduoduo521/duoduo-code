import { defineConfig, devices } from "@playwright/test"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`
const reuse = process.env.PLAYWRIGHT_REUSE_SERVER === "1"
const ci = !!process.env.CI
// CI runner 只有 2 vCPU，多 workers + vite + 后端会互相饿死（单测 boot 30~70s、
// 主线程 BLOCKED 长达 17s），导致大面积超时。现在套件含长流/长轮询的
// prompt 全链路用例（对 CPU 饱和敏感），实测 2 workers 下这些用例在负载
// 高峰批量超时而单跑全绿——固定 1 worker（PLAYWRIGHT_WORKERS 可覆盖）。
const workers = Number(process.env.PLAYWRIGHT_WORKERS ?? 1) || undefined
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
  timeout: ci ? 90_000 : 30_000,
  expect: {
    timeout: ci ? 10_000 : 5_000,
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
