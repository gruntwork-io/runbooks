/**
 * Mock the "electron" module for a bun test file.
 *
 * bun runs every test file in one process, and the first mock.module() call
 * for a module fixes its export names: later calls can replace the values but
 * not add names. A file that mocks only the names it needs therefore breaks
 * the named imports of any later file that needs different ones. Every
 * electron mock goes through here so each call declares the same names — one
 * inert stub for every export the main process imports. Add a name below when
 * main starts importing a new one.
 *
 * Call it before importing the module under test.
 */
import { mock } from "bun:test"

const inertElectron = {
  app: {},
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  Menu: {},
  nativeTheme: {},
  net: {},
  protocol: {},
  session: {},
  shell: {},
}

export type ElectronMock = Partial<Record<keyof typeof inertElectron, unknown>>

export function mockElectron(overrides: ElectronMock): void {
  mock.module("electron", () => ({ ...inertElectron, ...overrides }))
}
