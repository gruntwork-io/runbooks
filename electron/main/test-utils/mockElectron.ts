/**
 * Mock the `electron` module for a bun test file.
 *
 * bun runs every test file in one process and keeps a single module record
 * for "electron": a later mock.module("electron") can replace the values of
 * exports an earlier one declared, but cannot add new ones. So each test file
 * that mocks electron goes through here, which always declares the same
 * export names (inert stubs unless overridden) whatever order the files run.
 *
 * Call it before importing the module under test.
 */
import { mock } from "bun:test"

export function mockElectron(overrides: Record<string, unknown>): void {
  mock.module("electron", () => ({
    app: {},
    ipcMain: { handle: () => {} },
    BrowserWindow: class {},
    nativeTheme: {},
    session: {},
    shell: {},
    ...overrides,
  }))
}
