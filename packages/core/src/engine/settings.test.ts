import { describe, expect, it } from "bun:test"
import { Context, Effect, Exit, Fiber, Layer, Option, Scope, Stream } from "effect"
import { MAX_SETTINGS_BYTES } from "../services/SettingsFile.ts"
import {
  type MemorySettingsFile,
  memorySettingsFile,
  SETTINGS_PATH,
} from "../test-utils/TestSettingsFile.ts"
import {
  Caller,
  type Origin,
  type Settings,
  type SettingsChange,
  type SettingsView,
} from "./protocol.ts"
import { DEFAULT_SETTINGS, SettingsStore, type SettingsStoreShape } from "./settings.ts"

/** A settings file's text, as a release with settings version `version` writes it. */
const fileOf = (settings: Record<string, unknown>, version = 1) =>
  JSON.stringify({ version, settings })

/** What the file holds now, parsed. */
const savedIn = (file: MemorySettingsFile): unknown => JSON.parse(file.text() ?? "null")

/** Starts the store over `file`, as the engine does when it starts, and runs `use` with it. */
const withStore = <A, E>(
  file: MemorySettingsFile,
  use: (store: SettingsStoreShape) => Effect.Effect<A, E, Caller>,
  origin: Origin = "person",
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* SettingsStore)
    }).pipe(
      Effect.provide(SettingsStore.layer),
      Effect.provide(file.layer),
      Effect.provideService(Caller, { origin }),
    ),
  )

const viewOf = (file: MemorySettingsFile) => withStore(file, (store) => store.get)

const change = (file: MemorySettingsFile, changes: SettingsChange) =>
  withStore(file, (store) => store.change(changes))

describe("the settings store", () => {
  it("starts from the defaults with no settings file, and writes none until a person changes one", async () => {
    const file = memorySettingsFile()
    expect(await viewOf(file)).toEqual({
      settings: DEFAULT_SETTINGS,
      file: SETTINGS_PATH,
      problems: [],
    })
    expect(file.replaced).toEqual([])
  })

  it("applies the settings the file holds, and the defaults for the rest", async () => {
    const file = memorySettingsFile(fileOf({ theme: "dark", caBundleFile: "/etc/corp/ca.pem" }))
    const { settings, problems } = await viewOf(file)
    expect(settings).toEqual({
      ...DEFAULT_SETTINGS,
      theme: "dark",
      caBundleFile: "/etc/corp/ca.pem",
    })
    expect(problems).toEqual([])
  })

  it("saves a change, applies it, and has it after a restart", async () => {
    const file = memorySettingsFile()
    const changed = await change(file, { theme: "light", proxy: "http://proxy.corp:3128" })
    const expected: Settings = {
      ...DEFAULT_SETTINGS,
      theme: "light",
      proxy: "http://proxy.corp:3128",
    }
    expect(changed).toEqual({
      _tag: "Changed",
      settings: { settings: expected, file: SETTINGS_PATH, problems: [] },
    })
    expect((await viewOf(file)).settings).toEqual(expected)
  })

  it("saves only what a person set, so a default that changes later still applies", async () => {
    const file = memorySettingsFile(fileOf({ theme: "dark" }))
    await change(file, { instructionMode: true })
    expect(savedIn(file)).toEqual({
      version: 1,
      settings: { theme: "dark", instructionMode: true },
    })
  })

  it("keeps a value it does not take: shows the default, names it, and writes it back until a change sets it", async () => {
    const file = memorySettingsFile(fileOf({ theme: "purple", instructionMode: true }))
    const view = await viewOf(file)
    expect(view.settings).toEqual({ ...DEFAULT_SETTINGS, instructionMode: true })
    expect(view.problems).toEqual([
      { _tag: "InvalidSetting", setting: "theme", message: expect.stringContaining('"light"') },
    ])

    await change(file, { instructionMode: false })
    expect(savedIn(file)).toEqual({
      version: 1,
      settings: { theme: "purple", instructionMode: false },
    })
    expect((await viewOf(file)).problems).toHaveLength(1)

    const fixed = await change(file, { theme: "dark" })
    expect(fixed._tag === "Changed" && fixed.settings.problems).toEqual([])
    expect(savedIn(file)).toEqual({
      version: 1,
      settings: { theme: "dark", instructionMode: false },
    })
  })

  it("keeps a setting it does not know, names it, and writes it back", async () => {
    const file = memorySettingsFile(fileOf({ theme: "dark", density: "compact" }))
    expect((await viewOf(file)).problems).toEqual([{ _tag: "UnknownSetting", setting: "density" }])
    await change(file, { theme: "light" })
    expect(savedIn(file)).toEqual({
      version: 1,
      settings: { theme: "light", density: "compact" },
    })
  })

  it("reads a newer version's settings it knows, refuses every change, and never writes the file", async () => {
    const text = fileOf({ theme: "dark", density: "compact", proxy: { url: "http://p:1" } }, 2)
    const file = memorySettingsFile(text)
    const view = await viewOf(file)
    expect(view.settings).toEqual({ ...DEFAULT_SETTINGS, theme: "dark" })
    expect(view.problems).toEqual([{ _tag: "Newer", version: 2 }])

    expect(await change(file, { theme: "light" })).toEqual({
      _tag: "ReadOnly",
      problem: { _tag: "Newer", version: 2 },
    })
    expect(file.replaced).toEqual([])
    expect(file.text()).toBe(text)
    expect((await viewOf(file)).settings.theme).toBe("dark")
  })

  describe("a file that is not settings", () => {
    const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`s${i}`, i]))
    const files: ReadonlyArray<readonly [string, string, RegExp]> = [
      ["not JSON", '{"version": 1, "settings": {"theme": "dark"', /not JSON/],
      ["larger than the limit", " ".repeat(MAX_SETTINGS_BYTES + 1), /larger than 65536 bytes/],
      ["JSON that is not an object", "[]", /Expected/],
      ["no version", JSON.stringify({ settings: { theme: "dark" } }), /version/],
      ["version 0", fileOf({ theme: "dark" }, 0), /version/],
      [
        "settings that are not an object",
        JSON.stringify({ version: 1, settings: "dark" }),
        /settings/,
      ],
      ["more settings than any version has", fileOf(tooMany), /settings/],
    ]

    for (const [what, text, reason] of files)
      it(`is copied aside, whole, and left in place, and the defaults apply: ${what}`, async () => {
        const file = memorySettingsFile(text)
        const view = await viewOf(file)
        expect(view.settings).toEqual(DEFAULT_SETTINGS)
        expect(view.problems).toEqual([
          { _tag: "KeptAside", reason: expect.stringMatching(reason), keptAt: expect.any(String) },
        ])
        expect(file.aside()).toBe(text)
        expect(file.text()).toBe(text)
        expect(file.replaced).toEqual([])
      })

    it("is replaced by the next change, and its copy stays", async () => {
      const text = "{not json"
      const file = memorySettingsFile(text)
      expect(await change(file, { theme: "dark" })).toMatchObject({ _tag: "Changed" })
      expect(savedIn(file)).toEqual({ version: 1, settings: { theme: "dark" } })
      expect(file.aside()).toBe(text)
    })
  })

  it("never replaces a file it could not read, or could not copy aside: every change is refused", async () => {
    const unreadable = memorySettingsFile(fileOf({ theme: "dark" }), { read: true })
    expect((await viewOf(unreadable)).problems).toEqual([
      { _tag: "Unreadable", reason: "It could not be read: disk error" },
    ])
    expect(await change(unreadable, { theme: "light" })).toMatchObject({
      _tag: "ReadOnly",
      problem: { _tag: "Unreadable" },
    })
    expect(unreadable.replaced).toEqual([])

    const stuck = memorySettingsFile("{not json", { keepAside: true })
    const view = await viewOf(stuck)
    expect(view.settings).toEqual(DEFAULT_SETTINGS)
    expect(view.problems).toEqual([
      { _tag: "Unreadable", reason: expect.stringMatching(/not JSON.*could not be copied aside/) },
    ])
    expect(await change(stuck, { theme: "light" })).toMatchObject({ _tag: "ReadOnly" })
    expect(stuck.replaced).toEqual([])
    expect(stuck.text()).toBe("{not json")
  })

  it("lets an agent read the settings, and refuses its change", async () => {
    const file = memorySettingsFile(fileOf({ agentAccess: true }))
    const refused = await withStore(
      file,
      (store) =>
        Effect.gen(function* () {
          expect((yield* store.get).settings.agentAccess).toBe(true)
          return yield* store.change({ agentAccess: false, caBundleFile: "/tmp/mine.pem" })
        }).pipe(Effect.flip),
      "agent",
    )
    expect(refused).toMatchObject({ _tag: "Forbidden", command: "ChangeSettings", origin: "agent" })
    expect(file.replaced).toEqual([])
  })

  it("never saves a setting the protocol does not have, whatever an in-process caller passes", async () => {
    const file = memorySettingsFile()
    const changes: SettingsChange = Object.assign({ theme: "dark" as const }, { fontSize: 14 })
    const changed = await change(file, changes)
    expect(changed._tag === "Changed" && changed.settings.settings).not.toHaveProperty("fontSize")
    expect(savedIn(file)).toEqual({ version: 1, settings: { theme: "dark" } })
  })

  it("changes nothing when the file cannot be written", async () => {
    const file = memorySettingsFile(undefined, { replace: true })
    const failed = await withStore(file, (store) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(store.change({ theme: "dark" }))
        return { error, after: yield* store.get }
      }),
    )
    expect(failed.error).toMatchObject({
      _tag: "SettingsNotSaved",
      file: SETTINGS_PATH,
      message: "disk error",
    })
    expect(failed.after.settings).toEqual(DEFAULT_SETTINGS)
  })

  it("refuses a change that would make the file larger than it reads, and writes nothing", async () => {
    const file = memorySettingsFile(fileOf({ note: "x".repeat(MAX_SETTINGS_BYTES - 1000) }))
    const refused = await withStore(file, (store) =>
      Effect.flip(store.change({ caBundleFile: `/${"c".repeat(4000)}` })),
    )
    expect(refused).toMatchObject({
      _tag: "SettingsNotSaved",
      message: `The settings would be larger than ${MAX_SETTINGS_BYTES} bytes.`,
    })
    expect(file.replaced).toEqual([])
  })

  it("shows a watcher the settings now, then the latest after each change", async () => {
    const themes = await withStore(memorySettingsFile(), (store) =>
      Effect.scoped(
        Effect.gen(function* () {
          const pull = yield* Stream.toPull(store.watch)
          const seen: SettingsView[] = [...(yield* pull)]
          yield* store.change({ theme: "dark" })
          seen.push(...(yield* pull))
          // Two changes before the watcher reads again: it gets the latest once.
          yield* store.change({ theme: "light" })
          yield* store.change({ instructionMode: true })
          seen.push(...(yield* pull))
          // And no more until the next change: it holds one wake, not one for each.
          expect(Option.isNone(yield* Effect.timeoutOption(pull, "50 millis"))).toBe(true)
          return seen.map(({ settings }) => [settings.theme, settings.instructionMode])
        }),
      ),
    )
    expect(themes).toEqual([
      ["system", false],
      ["dark", false],
      ["light", true],
    ])
  })

  it("ends each watch when the store closes, so a watcher does not wait forever", async () => {
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const storeScope = yield* Scope.make()
        const context = yield* Layer.buildWithScope(
          SettingsStore.layer.pipe(Layer.provide(memorySettingsFile().layer)),
          storeScope,
        )
        const watcher = yield* Effect.forkChild(
          Stream.runCollect(Context.get(context, SettingsStore).watch),
          { startImmediately: true },
        )
        yield* Scope.close(storeScope, Exit.void)
        return yield* Fiber.join(watcher).pipe(Effect.timeout("1 second"))
      }),
    )
    expect(seen.map(({ settings }) => settings.theme)).toEqual(["system"])
  })
})
