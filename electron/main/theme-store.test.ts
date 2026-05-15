import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"

// theme-store.ts imports electron's `app` only for `app.getPath("userData")`.
// Mock it to point at a per-test temp dir so the module is testable without an
// Electron runtime. The mock reads `tmpDir` lazily, so reassigning it in
// beforeEach takes effect for each test.
let tmpDir = ""
mock.module("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "userData") return tmpDir
      throw new Error(`unexpected app.getPath(${name})`)
    },
  },
}))

const { getStoredTheme, setStoredTheme } = await import("./theme-store.ts")

const themeFile = () => nodePath.join(tmpDir, "theme.json")

describe("theme-store", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-theme-store-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("getStoredTheme", () => {
    it("defaults to 'system' when the file does not exist", () => {
      expect(getStoredTheme()).toBe("system")
    })

    it("defaults to 'system' when the file is corrupt JSON", () => {
      fs.writeFileSync(themeFile(), "{ not json")
      expect(getStoredTheme()).toBe("system")
    })

    it("defaults to 'system' when the theme value is not recognised", () => {
      fs.writeFileSync(themeFile(), JSON.stringify({ theme: "purple" }))
      expect(getStoredTheme()).toBe("system")
    })

    it("defaults to 'system' when the theme key is missing", () => {
      fs.writeFileSync(themeFile(), JSON.stringify({ somethingElse: true }))
      expect(getStoredTheme()).toBe("system")
    })

    it.each(["light", "dark", "system"] as const)(
      "returns the stored value '%s'",
      (theme) => {
        fs.writeFileSync(themeFile(), JSON.stringify({ theme }))
        expect(getStoredTheme()).toBe(theme)
      },
    )
  })

  describe("setStoredTheme", () => {
    it.each(["light", "dark", "system"] as const)(
      "round-trips '%s' through getStoredTheme",
      (theme) => {
        setStoredTheme(theme)
        expect(getStoredTheme()).toBe(theme)
      },
    )

    it("overwrites a previously stored value", () => {
      setStoredTheme("dark")
      setStoredTheme("light")
      expect(getStoredTheme()).toBe("light")
    })

    it("does not throw when the userData directory is missing", () => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      expect(() => setStoredTheme("dark")).not.toThrow()
      // The write failed silently, so the preference falls back to the default.
      expect(getStoredTheme()).toBe("system")
    })
  })
})
