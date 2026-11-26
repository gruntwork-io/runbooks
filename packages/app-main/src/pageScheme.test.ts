import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { NodeFileSystemLive } from "@runbooks/platform-node/layers/NodeFileSystem"
import { APP_PAGE, pageFile } from "./pageScheme.ts"

// Layout, under a realpath'd temp folder (macOS' /var is a symlink):
//   outside/secret.txt
//   renderer/index.html            <- the build's root
//   renderer/assets/index.js
//   renderer/leak.js -> ../outside/secret.txt
let folder = ""
let root = ""

beforeEach(() => {
  folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), "runbooks-page-scheme-")))
  root = path.join(folder, "renderer")
  mkdirSync(path.join(folder, "outside"))
  writeFileSync(path.join(folder, "outside", "secret.txt"), "secret")
  mkdirSync(path.join(root, "assets"), { recursive: true })
  writeFileSync(path.join(root, "index.html"), "<!doctype html>")
  writeFileSync(path.join(root, "assets", "index.js"), "")
  symlinkSync("../outside/secret.txt", path.join(root, "leak.js"))
})

afterEach(() => rmSync(folder, { recursive: true, force: true }))

const find = (url: string) =>
  Effect.runPromise(pageFile(url, root).pipe(Effect.provide(NodeFileSystemLive)))

describe("the page's scheme", () => {
  it("serves the page the window loads, and the files of the build by their path", async () => {
    expect(await find(APP_PAGE.href)).toBe(path.join(root, "index.html"))
    expect(await find("runbooks-app://window/assets/index.js")).toBe(
      path.join(root, "assets", "index.js"),
    )
  })

  it("refuses another scheme or host", async () => {
    expect(await find("runbooks-app://other/index.html")).toBeUndefined()
    expect(await find("runbook-asset://window/index.html")).toBeUndefined()
    expect(await find(`file://${path.join(root, "index.html")}`)).toBeUndefined()
  })

  it("refuses traversal, including percent-encoded separators", async () => {
    expect(await find("runbooks-app://window/..%2Foutside%2Fsecret.txt")).toBeUndefined()
    expect(
      await find("runbooks-app://window/assets/..%2F..%2Foutside%2Fsecret.txt"),
    ).toBeUndefined()
  })

  it("refuses a symlink that points outside the build", async () => {
    expect(await find("runbooks-app://window/leak.js")).toBeUndefined()
  })

  it("refuses malformed percent-encoding", async () => {
    expect(await find("runbooks-app://window/%E0%A4%A.js")).toBeUndefined()
  })

  it("serves no folder", async () => {
    expect(await find("runbooks-app://window/")).toBeUndefined()
    expect(await find("runbooks-app://window/assets")).toBeUndefined()
  })
})
