import { describe, test, expect } from "bun:test"
import { FileIgnore } from "../../src/file/ignore"

test("match nested and non-nested", () => {
  expect(FileIgnore.match("node_modules/index.js")).toBe(true)
  expect(FileIgnore.match("node_modules")).toBe(true)
  expect(FileIgnore.match("node_modules/")).toBe(true)
  expect(FileIgnore.match("node_modules/bar")).toBe(true)
  expect(FileIgnore.match("node_modules/bar/")).toBe(true)
})

describe("FileIgnore .env files", () => {
  test(".env file is ignored", () => {
    expect(FileIgnore.match(".env")).toBe(true)
  })

  test(".env in subdirectory is ignored", () => {
    expect(FileIgnore.match("project/.env")).toBe(true)
    expect(FileIgnore.match("apps/web/.env")).toBe(true)
  })

  test(".env.local is ignored", () => {
    expect(FileIgnore.match(".env.local")).toBe(true)
  })

  test(".env.production is ignored", () => {
    expect(FileIgnore.match(".env.production")).toBe(true)
  })

  test(".env.development is ignored", () => {
    expect(FileIgnore.match(".env.development")).toBe(true)
  })

  test(".env.test is ignored", () => {
    expect(FileIgnore.match(".env.test")).toBe(true)
  })

  test(".env.staging is ignored", () => {
    expect(FileIgnore.match(".env.staging")).toBe(true)
  })

  test(".env.production.local is ignored", () => {
    expect(FileIgnore.match(".env.production.local")).toBe(true)
  })

  test(".env.local in subdirectory is ignored", () => {
    expect(FileIgnore.match("packages/api/.env.local")).toBe(true)
  })

  test("normal files are not ignored", () => {
    expect(FileIgnore.match("src/index.ts")).toBe(false)
    expect(FileIgnore.match("package.json")).toBe(false)
    expect(FileIgnore.match("README.md")).toBe(false)
    expect(FileIgnore.match("tsconfig.json")).toBe(false)
  })

  test("files with 'env' in name but not .env pattern are not ignored", () => {
    expect(FileIgnore.match("environment.ts")).toBe(false)
    expect(FileIgnore.match("src/env.d.ts")).toBe(false)
    expect(FileIgnore.match("config/env.ts")).toBe(false)
  })

  test(".env in deeply nested directory is ignored", () => {
    expect(FileIgnore.match("packages/frontend/apps/web/.env")).toBe(true)
    expect(FileIgnore.match("a/b/c/d/.env.production")).toBe(true)
  })
})
