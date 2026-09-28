import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { assertNoNestedNodeModules } from "./no-nested-node-modules.ts"

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "no-nested-node-modules-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const mkdir = (rel: string) => mkdirSync(path.join(root, rel), { recursive: true })

describe("assertNoNestedNodeModules", () => {
  it("passes on a fresh checkout with no web/ or cli/ node_modules", () => {
    mkdir("web/src")
    mkdir("cli")
    expect(() => assertNoNestedNodeModules(root)).not.toThrow()
  })

  it("ignores dot-entries, which are tool caches rather than packages", () => {
    mkdir("web/node_modules/.vite/deps")
    mkdir("web/node_modules/.vite-temp")
    mkdir("web/node_modules/.tmp")
    mkdir("cli/node_modules/.cache")
    expect(() => assertNoNestedNodeModules(root)).not.toThrow()
  })

  it("passes when node_modules is a file rather than a directory", () => {
    mkdir("web")
    writeFileSync(path.join(root, "web/node_modules"), "")
    expect(() => assertNoNestedNodeModules(root)).not.toThrow()
  })

  it("fails with the removal hint when web/node_modules holds a package", () => {
    mkdir("web/node_modules/react")
    expect(() => assertNoNestedNodeModules(root)).toThrow(
      "web/node_modules contains packages from an old per-directory install",
    )
    expect(() => assertNoNestedNodeModules(root)).toThrow("rm -rf web/node_modules")
  })

  it("fails for a scoped package in cli/node_modules", () => {
    mkdir("cli/node_modules/@effect/platform")
    expect(() => assertNoNestedNodeModules(root)).toThrow("rm -rf cli/node_modules")
  })

  it("names both directories when both hold packages", () => {
    mkdir("web/node_modules/react")
    mkdir("cli/node_modules/effect")
    expect(() => assertNoNestedNodeModules(root)).toThrow(
      "rm -rf web/node_modules cli/node_modules",
    )
  })
})
