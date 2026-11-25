/**
 * The first start: the settings store keeping what today's app held in its
 * own files. Today's files are in an in-memory FileSystem, the settings
 * file in an in-memory SettingsFile.
 */
import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { FileSystem } from "../services/FileSystem.ts"
import { recordFileSystem, type ServiceCall } from "../test-utils/ServiceCalls.ts"
import { testFileSystem } from "../test-utils/TestFileSystem.ts"
import { type MemorySettingsFile, memorySettingsFile } from "../test-utils/TestSettingsFile.ts"
import { LEGACY_FILES, MAX_LEGACY_FILE_BYTES } from "./legacySettings.ts"
import type { SettingsChange, SettingsView } from "./protocol.ts"
import { DEFAULT_SETTINGS, SettingsStore } from "./settings.ts"

/** Today's app's data folder. */
const LEGACY = "/legacy"
const at = (name: string) => `${LEGACY}/${name}`

/** Today's files, as today's app writes them. */
const TODAY = {
  [at(LEGACY_FILES.customCa)]: JSON.stringify({ path: "/Users/me/corp-ca.pem" }),
  [at(LEGACY_FILES.theme)]: JSON.stringify({ theme: "dark" }),
  [at(LEGACY_FILES.agentAccess)]: JSON.stringify({ enabled: true, confirmRuns: true }),
  [at(LEGACY_FILES.vcsAuth)]: JSON.stringify(
    {
      recentGitLabHosts: ["gitlab.corp.example", "gitlab.com"],
      lastSelectedGitLabHost: "gitlab.corp.example",
      recentGitHubHosts: [],
    },
    null,
    2,
  ),
}

/** What the store keeps of `TODAY`: each setting not at its default. */
const KEPT: SettingsChange = {
  caBundleFile: "/Users/me/corp-ca.pem",
  theme: "dark",
  agentAccess: true,
  recentGitLabHosts: ["gitlab.corp.example", "gitlab.com"],
  lastSelectedGitLabHost: "gitlab.corp.example",
}

/** Starts the store over `file`, with today's files `legacy`, and gives the settings it starts with. */
const start = (
  file: MemorySettingsFile,
  legacy: Readonly<Record<string, string>>,
  calls: ServiceCall[] = [],
): Promise<SettingsView> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* SettingsStore).get
    }).pipe(
      Effect.provide(SettingsStore.importing(LEGACY)),
      Effect.provide(file.layer),
      Effect.provide(
        Layer.succeed(FileSystem, recordFileSystem(testFileSystem({ ...legacy }), calls)),
      ),
    ),
  )

const savedIn = (file: MemorySettingsFile): unknown => JSON.parse(file.text() ?? "null")

describe("the first start", () => {
  it("keeps today's settings, saves them, and reads today's files once only", async () => {
    const file = memorySettingsFile()
    const first = await start(file, TODAY)
    expect(first.settings).toEqual({ ...DEFAULT_SETTINGS, ...KEPT })
    expect(first.problems).toEqual([])
    expect(savedIn(file)).toEqual({ version: 1, settings: KEPT })

    // Today's app, run again, changes its files: this version does not read them again.
    const calls: ServiceCall[] = []
    const again = await start(file, { [at(LEGACY_FILES.theme)]: '{"theme":"light"}' }, calls)
    expect(again.settings).toEqual({ ...DEFAULT_SETTINGS, ...KEPT })
    expect(calls).toEqual([])
    expect(file.replaced).toHaveLength(1)
  })

  it("reads each of today's files through the FileSystem, at most so many bytes, and writes none", async () => {
    const calls: ServiceCall[] = []
    await start(memorySettingsFile(), TODAY, calls)
    expect(calls).toEqual(
      Object.values(LEGACY_FILES).map((name) => ({
        service: "FileSystem",
        method: "readFileUpTo",
        args: [at(name), MAX_LEGACY_FILE_BYTES],
      })),
    )
  })

  it("keeps the same settings each time it runs, until one is saved", async () => {
    const file = memorySettingsFile(undefined, { replace: true })
    const first = await start(file, TODAY)
    const second = await start(file, TODAY)
    expect(first.settings).toEqual({ ...DEFAULT_SETTINGS, ...KEPT })
    expect(second).toEqual(first)
    expect(file.text()).toBeUndefined()
  })

  it("writes no settings file when today's files hold nothing but defaults, or are not there", async () => {
    for (const legacy of [
      {},
      {
        [at(LEGACY_FILES.theme)]: '{"theme":"system"}',
        [at(LEGACY_FILES.agentAccess)]: '{"enabled":false,"confirmRuns":true}',
        [at(LEGACY_FILES.vcsAuth)]: '{"recentGitLabHosts":[],"recentGitHubHosts":[]}',
      },
    ]) {
      const file = memorySettingsFile()
      expect((await start(file, legacy)).settings).toEqual(DEFAULT_SETTINGS)
      expect(file.replaced).toEqual([])
    }
  })

  it("reads today's files as today's app does: agent access is off unless on, runs confirmed unless not", async () => {
    const cases: ReadonlyArray<readonly [string, [boolean, boolean]]> = [
      ['{"enabled":"yes","confirmRuns":false}', [false, false]],
      ['{"enabled":true}', [true, true]],
      ['{"enabled":true,"confirmRuns":"no"}', [true, true]],
      ["{}", [false, true]],
    ]
    for (const [text, expected] of cases) {
      const { settings } = await start(memorySettingsFile(), {
        [at(LEGACY_FILES.agentAccess)]: text,
      })
      expect({ text, got: [settings.agentAccess, settings.confirmAgentRuns] }).toEqual({
        text,
        got: expected,
      })
    }
  })

  it("keeps only the values this version takes, and the hosts a setting takes, five at most", async () => {
    const file = memorySettingsFile()
    const { settings } = await start(file, {
      [at(LEGACY_FILES.customCa)]: '{"path":"corp-ca.pem"}',
      [at(LEGACY_FILES.theme)]: '{"theme":"purple"}',
      [at(LEGACY_FILES.vcsAuth)]: JSON.stringify({
        recentGitHubHosts: [
          "ghe.corp.example",
          "me@ghe.corp.example",
          "has space",
          42,
          "ghe.corp.example",
          "a.example",
          "b.example",
          "c.example",
          "d.example",
          "e.example",
        ],
        lastSelectedGitHubHost: "https://ghe.corp.example/",
        lastSelectedGitLabHost: "gitlab.corp.example:8443",
      }),
    })
    expect(settings).toEqual({
      ...DEFAULT_SETTINGS,
      recentGitHubHosts: ["ghe.corp.example", "a.example", "b.example", "c.example", "d.example"],
      lastSelectedGitLabHost: "gitlab.corp.example:8443",
    })
  })

  it("gives nothing for a file that is too large, not JSON, or not an object, and keeps the rest", async () => {
    const { settings } = await start(memorySettingsFile(), {
      ...TODAY,
      // Valid within the bound, so only the bound keeps it out.
      [at(LEGACY_FILES.theme)]: `{"theme":"light"}${" ".repeat(MAX_LEGACY_FILE_BYTES)}`,
      [at(LEGACY_FILES.agentAccess)]: '{"enabled":true',
      [at(LEGACY_FILES.vcsAuth)]: '["gitlab.corp.example"]',
    })
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, caBundleFile: "/Users/me/corp-ca.pem" })
  })

  it("does not read today's files over a settings file, even one it cannot read", async () => {
    for (const text of ["{not json", JSON.stringify({ version: 2, settings: {} })]) {
      const calls: ServiceCall[] = []
      const { settings } = await start(memorySettingsFile(text), TODAY, calls)
      expect(settings).toEqual(DEFAULT_SETTINGS)
      expect(calls).toEqual([])
    }
  })
})
