/**
 * Mock the "electron" module for a bun test file.
 *
 * bun runs every test file in one process, and the first mock.module() call
 * for a module fixes its export names: later calls can replace the values but
 * not add names. A file that mocks only the names it needs therefore breaks
 * the named imports of any later file that needs different ones. Every
 * electron mock goes through here so each call declares the same names — one
 * inert stub for every export the main process and preload import. Add a name
 * below when either starts importing a new one.
 *
 * Call it before importing the module under test.
 */
import { mock } from "bun:test"

const inertElectron = {
  app: {},
  BrowserWindow: class {},
  contextBridge: {},
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  ipcRenderer: {},
  Menu: {},
  nativeTheme: {},
  net: {},
  protocol: {},
  safeStorage: {},
  session: {},
  shell: {},
}

export type ElectronMock = Partial<Record<keyof typeof inertElectron, unknown>>

export function mockElectron(overrides: ElectronMock): void {
  // The factory is synchronous, so the mock is registered by the time this
  // returns; mock.module only returns a promise for an async factory.
  void mock.module("electron", () => ({ ...inertElectron, ...overrides }))
}
