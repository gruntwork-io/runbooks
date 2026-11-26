import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Exit, Schema } from "effect"
import { ConfigureResult } from "@runbooks/core/plugin/generated/base"
import { Platform, PluginProcess, type PluginProtocol } from "@runbooks/core/plugin/transport"
import { binaryName, nodePluginProcess } from "./NodePluginProcess.ts"
import { MAX_LOCK_BYTES, readPluginsLock } from "./PluginsLock.ts"

const CHECKED_IN = path.resolve(import.meta.dirname, "../../../../resources/plugins.lock")

const PLATFORMS = Platform.literals
const HASH = "0".repeat(64)
const entry = (name: string, sha256: Record<string, string> = { "darwin-arm64": HASH }) => ({
  name,
  kind: "credential",
  version: "0.1.0",
  sha256,
})

let dir = ""
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "runbooks-plugins-lock-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const lockFile = (content: string) => {
  const file = path.join(dir, "plugins.lock")
  writeFileSync(file, content)
  return file
}

/** The lock's error, which must name the file. */
const problemOf = async (file: string) => {
  const exit = await Effect.runPromiseExit(readPluginsLock(file))
  if (Exit.isSuccess(exit)) throw new Error(`${file} decoded`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
  expect(error?._tag).toBe("PluginsLockInvalid")
  expect(error?.file).toBe(file)
  expect(error?.message.startsWith(`${file}: `)).toBe(true)
  return error?.problem ?? ""
}

describe("the checked-in lock", () => {
  it("pins the three credential plugins of one release, on every platform it builds", async () => {
    const plugins = await Effect.runPromise(readPluginsLock(CHECKED_IN))
    expect(plugins.map(({ kind, name }) => `${kind}/${name}`).sort()).toEqual([
      "credential/aws",
      "credential/azure",
      "credential/google",
    ])
    expect(new Set(plugins.map((plugin) => plugin.version)).size).toBe(1)
    for (const plugin of plugins) {
      expect(Object.keys(plugin.sha256).sort()).toEqual([...PLATFORMS].sort())
    }
  })

  it("has the owner check each binary against its pin, on every platform", async () => {
    const plugins = await Effect.runPromise(readPluginsLock(CHECKED_IN))
    const protocol: PluginProtocol<never, unknown, unknown> = {
      kind: "credential",
      errorKinds: [],
      configure: { name: "configure", params: Schema.Unknown, result: ConfigureResult },
      methods: [],
    }
    const runDir = path.join(dir, "run")
    mkdirSync(runDir)
    const open = (plugin: string, platform: Platform) =>
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* PluginProcess
          return yield* owner.open(protocol, plugin, {}, (fields) => fields)
        }),
      ).pipe(
        Effect.provide(
          nodePluginProcess({ binDir: dir, runDir, platform, plugins, caller: "runbooks/test" }),
        ),
        Effect.flip,
      )
    for (const { kind, name, sha256 } of plugins) {
      for (const platform of PLATFORMS) {
        // A file that isn't the plugin: the owner refuses it for its pin.
        writeFileSync(path.join(dir, binaryName(kind, name, platform)), "not the plugin")
        expect(await Effect.runPromise(open(name, platform))).toMatchObject({
          _tag: "PluginHashMismatch",
          plugin: name,
          expected: sha256[platform],
        })
      }
    }
  })
})

describe("reading a lock", () => {
  it("returns its entries", async () => {
    const plugins = await Effect.runPromise(
      readPluginsLock(lockFile(JSON.stringify({ plugins: [entry("aws"), entry("google", {})] }))),
    )
    expect<unknown>(plugins).toEqual([entry("aws"), entry("google", {})])
  })

  it("names a missing file", async () => {
    expect(await problemOf(path.join(dir, "missing.lock"))).toBe("no such file")
  })

  it("refuses a folder", async () => {
    const folder = path.join(dir, "plugins.lock")
    mkdirSync(folder)
    expect(await problemOf(folder)).toBe("not a regular file")
  })

  it(`refuses a file past MAX_LOCK_BYTES, and takes one of exactly that size`, async () => {
    const lock = JSON.stringify({ plugins: [] })
    const exact = lockFile(lock + " ".repeat(MAX_LOCK_BYTES - lock.length))
    expect(await Effect.runPromise(readPluginsLock(exact))).toEqual([])
    expect(await problemOf(lockFile(lock + " ".repeat(MAX_LOCK_BYTES - lock.length + 1)))).toBe(
      `larger than ${MAX_LOCK_BYTES} bytes`,
    )
  })

  it("refuses text that is not JSON", async () => {
    expect(await problemOf(lockFile('{"plugins": ['))).toStartWith("not JSON: ")
  })

  it("names every problem, with where it is in the file", async () => {
    const problem = await problemOf(
      lockFile(
        JSON.stringify({
          plugins: [
            entry("aws", { "darwin-arm64": "abc", linux_amd64: HASH }),
            { ...entry("google"), kind: "cloud" },
          ],
        }),
      ),
    )
    expect(problem).toContain('at ["plugins"][0]["sha256"]["darwin-arm64"]')
    expect(problem).toContain('at ["plugins"][1]["kind"]')
  })

  it("names a platform the contract does not know", async () => {
    const problem = await problemOf(
      lockFile(JSON.stringify({ plugins: [entry("aws", { linux_amd64: HASH })] })),
    )
    expect(problem).toContain('at ["plugins"][0]["sha256"]["linux_amd64"]')
  })

  it("refuses a plugin pinned twice in one kind, and takes one name in two kinds", async () => {
    const problem = await problemOf(
      lockFile(JSON.stringify({ plugins: [entry("aws"), entry("google"), entry("aws")] })),
    )
    expect(problem).toContain("The credential plugin aws is pinned twice.")
    expect(problem).toContain('at ["plugins"][2]')
    const plugins = await Effect.runPromise(
      readPluginsLock(
        lockFile(JSON.stringify({ plugins: [entry("aws"), { ...entry("aws"), kind: "driver" }] })),
      ),
    )
    expect(plugins).toHaveLength(2)
  })
})
