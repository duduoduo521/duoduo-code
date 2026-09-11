import { test, expect, beforeAll, afterEach, afterAll, mock } from "bun:test"
import path from "path"

// ---------------------------------------------------------------------------
// extractZip — verifies command construction per platform
//
// Instead of shelling out (which requires `unzip` / PowerShell), we mock
// Process.run and assert the correct command vector is built.
// ---------------------------------------------------------------------------

const runMock = mock<(cmd: string[]) => Promise<{ code: number }>>().mockImplementation(async () => ({ code: 0 }))

// Register mock BEFORE the module is loaded
// oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
mock.module("../../src/util/process", () => ({
  run: runMock,
}))

let Archive: typeof import("../../src/util/archive")
const originalPlatform = process.platform

beforeAll(async () => {
  Archive = await import("../../src/util/archive")
})

afterEach(() => {
  runMock.mockClear()
})

afterAll(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
})

function setPlatform(platform: "darwin" | "win32" | "linux") {
  Object.defineProperty(process, "platform", { value: platform, configurable: true })
}

test("extractZip on Unix uses unzip command with correct args", async () => {
  setPlatform("darwin")
  await Archive.extractZip("/tmp/test.zip", "/tmp/output")
  expect(runMock).toHaveBeenCalledTimes(1)
  const cmd = runMock.mock.calls[0][0]
  expect(cmd[0]).toBe("unzip")
  expect(cmd).toContain("-o")
  expect(cmd).toContain("-q")
  // unzip -o -q <zipPath> -d <destDir>
  expect(cmd[cmd.length - 3]).toBe("/tmp/test.zip")
  expect(cmd[cmd.length - 2]).toBe("-d")
  expect(cmd[cmd.length - 1]).toBe("/tmp/output")
})

test("extractZip on Windows uses PowerShell Expand-Archive", async () => {
  setPlatform("win32")
  await Archive.extractZip("C:\\test.zip", "C:\\output")
  expect(runMock).toHaveBeenCalledTimes(1)
  const cmd = runMock.mock.calls[0][0]
  expect(cmd[0]).toBe("powershell")
  expect(cmd).toContain("-NoProfile")
  expect(cmd).toContain("-NonInteractive")
  expect(cmd).toContain("-Command")
  const psCmd = cmd[cmd.length - 1]
  expect(psCmd).toContain("Expand-Archive")
  expect(psCmd).toContain(path.resolve("C:\\test.zip"))
  expect(psCmd).toContain(path.resolve("C:\\output"))
})

test("extractZip on Linux uses unzip command", async () => {
  setPlatform("linux")
  await Archive.extractZip("/data/archive.zip", "/data/out")
  expect(runMock).toHaveBeenCalledTimes(1)
  const cmd = runMock.mock.calls[0][0]
  expect(cmd[0]).toBe("unzip")
  // unzip -o -q <zipPath> -d <destDir>
  expect(cmd[cmd.length - 3]).toBe("/data/archive.zip")
  expect(cmd[cmd.length - 2]).toBe("-d")
  expect(cmd[cmd.length - 1]).toBe("/data/out")
})

test("extractZip resolves relative paths to absolute on Windows", async () => {
  setPlatform("win32")
  await Archive.extractZip("relative.zip", "relative/dest")
  expect(runMock).toHaveBeenCalledTimes(1)
  const cmd = runMock.mock.calls[0][0]
  const psCmd = cmd[cmd.length - 1]
  expect(psCmd).toContain(path.resolve("relative.zip"))
  expect(psCmd).toContain(path.resolve("relative/dest"))
})

test("extractZip resolves relative paths on Unix", async () => {
  setPlatform("darwin")
  await Archive.extractZip("relative.zip", "relative/dest")
  expect(runMock).toHaveBeenCalledTimes(1)
  const cmd = runMock.mock.calls[0][0]
  // On Unix the raw path is passed without path.resolve()
  expect(cmd[cmd.length - 3]).toBe("relative.zip")
  expect(cmd[cmd.length - 2]).toBe("-d")
  expect(cmd[cmd.length - 1]).toBe("relative/dest")
})
