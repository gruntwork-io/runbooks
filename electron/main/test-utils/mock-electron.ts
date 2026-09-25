/**
 * Mock the "electron" module for a bun test file.
 *
 * bun runs every test file in one process, and the first mock.module() call
 * for a module fixes its export names: later calls can replace the values but
 * not add names. A file that mocks only the names it needs therefore breaks
 * the named imports of any later file that needs different ones. Every
 * electron mock goes through here so each call declares the same names; add a
 * name below when a test needs a new one.
 */
import { mock } from "bun:test"

export interface ElectronMock {
  app?: unknown
  ipcMain?: unknown
}

export function mockElectron(exports: ElectronMock): void {
  mock.module("electron", () => ({ app: undefined, ipcMain: undefined, ...exports }))
}
