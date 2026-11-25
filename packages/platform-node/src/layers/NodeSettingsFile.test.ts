import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Effect, Layer, Option } from "effect"
import { Caller } from "@runbooks/core/protocol"
import { MAX_SETTINGS_BYTES, SettingsFile } from "@runbooks/core/services/SettingsFile"
import { DEFAULT_SETTINGS, SettingsStore } from "@runbooks/core/settings"
import { NodeFileSystemLive } from "./NodeFileSystem.ts"
import { nodeSettingsFile } from "./NodeSettingsFile.ts"

let root = ""
/** The data folder the entry point would pass: missing until something is written. */
let data = ""
let file = ""

beforeEach(() => {
  root = nodeFs.realpathSync(nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-settings-")))
  data = nodePath.join(root, "data")
  file = nodePath.join(data, "settings.json")
})

afterEach(() => {
  nodeFs.rmSync(root, { recursive: true, force: true })
})

const run = <A, E>(use: (settings: SettingsFile["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* SettingsFile)
    }).pipe(Effect.provide(nodeSettingsFile(data))),
  )

const modeOf = (at: string) => nodeFs.statSync(at).mode & 0o777

describe("the settings file", () => {
  it("is in the data folder, and reads as none until something writes it", async () => {
    expect(await run((settings) => Effect.succeed(settings.path))).toBe(file)
    expect(Option.isNone(await run((settings) => settings.read))).toBe(true)
    expect(nodeFs.existsSync(data)).toBe(false)
  })

  it("is replaced in one step: a reader that opened the old file reads all of it", async () => {
    const old = `{"version":1,"settings":{"theme":"${"dark".repeat(1000)}"}}`
    await run((settings) => settings.replace(old))
    const reader = nodeFs.openSync(file, "r")
    try {
      await run((settings) => settings.replace('{"version":1,"settings":{}}'))
      const buffer = Buffer.alloc(old.length + 100)
      const read = nodeFs.readSync(reader, buffer, 0, buffer.length, 0)
      expect(buffer.subarray(0, read).toString("utf8")).toBe(old)
    } finally {
      nodeFs.closeSync(reader)
    }
    expect(nodeFs.readFileSync(file, "utf8")).toBe('{"version":1,"settings":{}}')
  })

  it("is readable and writable by its owner only, replacing one that was not, in a folder only its owner opens", async () => {
    nodeFs.mkdirSync(data, { mode: 0o755 })
    nodeFs.writeFileSync(file, "{}", { mode: 0o644 })
    nodeFs.chmodSync(file, 0o644)
    await run((settings) => settings.replace('{"version":1,"settings":{}}'))
    expect(modeOf(file)).toBe(0o600)

    const fresh = nodePath.join(root, "fresh")
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* SettingsFile).replace("{}")
      }).pipe(Effect.provide(nodeSettingsFile(fresh))),
    )
    expect(modeOf(fresh)).toBe(0o700)
    expect(modeOf(nodePath.join(fresh, "settings.json"))).toBe(0o600)
  })

  it("is written over a temporary file a crash left behind, which goes", async () => {
    nodeFs.mkdirSync(data)
    nodeFs.writeFileSync(`${file}.tmp`, "half a file", { mode: 0o644 })
    await run((settings) => settings.replace('{"version":1,"settings":{}}'))
    expect(nodeFs.readdirSync(data)).toEqual(["settings.json"])
    expect(modeOf(file)).toBe(0o600)
  })

  it("is read up to its limit, saying it held more, however large it is", async () => {
    nodeFs.mkdirSync(data)
    nodeFs.writeFileSync(file, "x".repeat(MAX_SETTINGS_BYTES + 10))
    const head = await run((settings) => settings.read)
    expect(head).toEqual(Option.some({ text: "x".repeat(MAX_SETTINGS_BYTES), truncated: true }))

    // Sparse: it takes no disk, and more memory than a whole read may use.
    nodeFs.truncateSync(file, 3 * 1024 ** 3)
    const huge = await run((settings) => settings.read)
    expect(Option.map(huge, ({ text, truncated }) => [text.length, truncated])).toEqual(
      Option.some([MAX_SETTINGS_BYTES, true]),
    )
  })

  it("fails to read something that is not a file, rather than wait on it", async () => {
    nodeFs.mkdirSync(file, { recursive: true })
    const error = await run((settings) => Effect.flip(settings.read))
    expect(error).toMatchObject({ _tag: "FileReadError", path: file })
  })

  it("is copied aside whole, owner only, and left as it is", async () => {
    nodeFs.mkdirSync(data)
    const text = `not settings ${"x".repeat(MAX_SETTINGS_BYTES)}`
    nodeFs.writeFileSync(file, text, { mode: 0o644 })
    const keptAt = await run((settings) => settings.keepAside)
    expect(keptAt).toBe(nodePath.join(data, "settings.unreadable.json"))
    expect(nodeFs.readFileSync(keptAt, "utf8")).toBe(text)
    expect(modeOf(keptAt)).toBe(0o600)
    expect(nodeFs.readFileSync(file, "utf8")).toBe(text)
  })
})

describe("the settings store over the file", () => {
  const withStore = <A, E>(use: (store: SettingsStore["Service"]) => Effect.Effect<A, E, Caller>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* use(yield* SettingsStore)
      }).pipe(
        Effect.provide(SettingsStore.layer),
        Effect.provide(nodeSettingsFile(data)),
        Effect.provideService(Caller, { origin: "person" }),
      ),
    )

  it("has a change after a restart", async () => {
    await withStore((store) => store.change({ theme: "dark", caBundleFile: "/etc/corp/ca.pem" }))
    const { settings } = await withStore((store) => store.get)
    expect(settings).toEqual({
      ...DEFAULT_SETTINGS,
      theme: "dark",
      caBundleFile: "/etc/corp/ca.pem",
    })
  })

  it("keeps a file that is not settings aside before a change replaces it", async () => {
    nodeFs.mkdirSync(data)
    nodeFs.writeFileSync(file, "{not json")
    await withStore((store) => store.change({ theme: "dark" }))
    expect(nodeFs.readFileSync(nodePath.join(data, "settings.unreadable.json"), "utf8")).toBe(
      "{not json",
    )
    expect(JSON.parse(nodeFs.readFileSync(file, "utf8"))).toEqual({
      version: 1,
      settings: { theme: "dark" },
    })
  })

  it("keeps today's settings on the first start, and leaves today's files as they were", async () => {
    const legacy = nodePath.join(root, "legacy")
    nodeFs.mkdirSync(legacy)
    const today = {
      "custom-ca.json": JSON.stringify({ path: "/etc/corp/ca.pem" }),
      "theme.json": JSON.stringify({ theme: "dark" }),
    }
    for (const [name, text] of Object.entries(today))
      nodeFs.writeFileSync(nodePath.join(legacy, name), text)
    const before = nodeFs.readdirSync(legacy).map((name) => {
      const stat = nodeFs.statSync(nodePath.join(legacy, name))
      return [name, stat.mtimeMs, stat.mode]
    })

    const { settings } = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SettingsStore).get
      }).pipe(
        Effect.provide(SettingsStore.importing(legacy)),
        Effect.provide(Layer.merge(nodeSettingsFile(data), NodeFileSystemLive)),
      ),
    )
    expect(settings).toEqual({
      ...DEFAULT_SETTINGS,
      theme: "dark",
      caBundleFile: "/etc/corp/ca.pem",
    })
    expect(JSON.parse(nodeFs.readFileSync(file, "utf8"))).toEqual({
      version: 1,
      settings: { caBundleFile: "/etc/corp/ca.pem", theme: "dark" },
    })
    expect(modeOf(file)).toBe(0o600)
    expect(
      nodeFs.readdirSync(legacy).map((name) => {
        const stat = nodeFs.statSync(nodePath.join(legacy, name))
        return [name, stat.mtimeMs, stat.mode]
      }),
    ).toEqual(before)
    for (const [name, text] of Object.entries(today))
      expect(nodeFs.readFileSync(nodePath.join(legacy, name), "utf8")).toBe(text)
  })
})
