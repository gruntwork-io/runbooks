import { describe, it, expect } from "bun:test"
import { Chunk, Effect, Layer, Stream } from "effect"
import { createScriptWatcher, createWatcher } from "./watcher.ts"
import { FileSystem, type FileChangeEvent, type WatchOptions } from "./services/FileSystem.ts"
import { makeTestFileSystem } from "./test-utils/TestFileSystem.ts"

const RUNBOOK = "/work/my-runbook/runbook.mdx"

/**
 * A FileSystem whose watch() replays `events` and then ends, recording the
 * paths and options it was asked to watch. A finite stream lets the debounce
 * flush its pending event without waiting on the clock.
 */
function replayingFs(events: FileChangeEvent[]) {
  const watched: Array<{ paths: string[]; options?: WatchOptions | undefined }> = []
  const layer = Layer.effect(
    FileSystem,
    Effect.map(FileSystem, (fs) => ({
      ...fs,
      watch: (paths: string[], options?: WatchOptions) => {
        watched.push({ paths, options })
        return Stream.fromIterable(events)
      },
    })),
  ).pipe(Layer.provide(makeTestFileSystem()))
  return { layer, watched }
}

const collect = (
  runbookPath: string,
  events: FileChangeEvent[],
  platform: NodeJS.Platform = "linux",
) => {
  const fs = replayingFs(events)
  return Effect.runPromise(
    createWatcher(runbookPath, platform).pipe(
      Effect.flatMap(Stream.runCollect),
      Effect.map(Chunk.toArray),
      Effect.provide(fs.layer),
    ),
  ).then((emitted) => ({ emitted, watched: fs.watched }))
}

describe("createWatcher", () => {
  it("watches only the directory that contains the runbook, not its subdirectories", async () => {
    // Clones, generated output, .git and node_modules live below the runbook;
    // watching them recursively costs an OS watch per directory and can hit
    // the watcher limit, which would stop watch mode.
    const { watched } = await collect(RUNBOOK, [])
    expect(watched).toEqual([{ paths: ["/work/my-runbook"], options: { depth: 0 } }])
  })

  it("emits changes to the runbook file", async () => {
    const { emitted } = await collect(RUNBOOK, [{ type: "change", path: RUNBOOK }])
    expect(emitted).toEqual([{ type: "change", path: RUNBOOK }])
  })

  it("ignores other files in the runbook's directory tree", async () => {
    const { emitted } = await collect(RUNBOOK, [
      { type: "add", path: "/work/my-runbook/generated/main.tf" },
      { type: "change", path: "/work/my-runbook/.git/index" },
      { type: "change", path: "/work/my-runbook/scripts/setup.sh" },
    ])
    expect(emitted).toEqual([])
  })

  it("keeps a runbook change that is followed by unrelated writes in the same burst", async () => {
    // A script writing generated files right after the save must not replace
    // the runbook's event in the debounce window and so swallow the reload.
    const { emitted } = await collect(RUNBOOK, [
      { type: "change", path: RUNBOOK },
      { type: "add", path: "/work/my-runbook/generated/out.txt" },
    ])
    expect(emitted).toEqual([{ type: "change", path: RUNBOOK }])
  })

  it("ignores deletions of the runbook", async () => {
    const { emitted } = await collect(RUNBOOK, [{ type: "unlink", path: RUNBOOK }])
    expect(emitted).toEqual([])
  })

  it.each(["darwin", "win32"] as const)(
    "matches the runbook's on-disk name case-insensitively on %s",
    async (platform) => {
      // Opening the directory resolves to "runbook.mdx"; the watcher reports
      // the file's real name.
      const onDisk = "/work/my-runbook/Runbook.mdx"
      const { emitted } = await collect(RUNBOOK, [{ type: "change", path: onDisk }], platform)
      expect(emitted).toEqual([{ type: "change", path: onDisk }])
    },
  )

  it("matches the runbook's name case-sensitively on linux", async () => {
    const { emitted } = await collect(
      RUNBOOK,
      [{ type: "change", path: "/work/my-runbook/Runbook.mdx" }],
      "linux",
    )
    expect(emitted).toEqual([])
  })
})

describe("createScriptWatcher", () => {
  const SETUP = "/work/my-runbook/scripts/setup.sh"
  const DEPLOY = "/work/my-runbook/scripts/deploy.sh"
  const CHECK = "/work/my-runbook/check.sh"

  const collectScripts = (
    scriptPaths: string[],
    events: FileChangeEvent[],
    platform: NodeJS.Platform = "linux",
  ) => {
    const fs = replayingFs(events)
    return Effect.runPromise(
      createScriptWatcher(scriptPaths, platform).pipe(
        Effect.flatMap(Stream.runCollect),
        Effect.map(Chunk.toArray),
        Effect.provide(fs.layer),
      ),
    ).then((emitted) => ({ emitted, watched: fs.watched }))
  }

  it("watches each directory that contains a script once, not its subdirectories", async () => {
    const { watched } = await collectScripts([SETUP, DEPLOY, CHECK], [])
    expect(watched).toEqual([
      { paths: ["/work/my-runbook/scripts", "/work/my-runbook"], options: { depth: 0 } },
    ])
  })

  it("emits the script that was written, including by an editor's save by rename", async () => {
    expect(
      (await collectScripts([SETUP, DEPLOY], [{ type: "change", path: SETUP }])).emitted,
    ).toEqual([[SETUP]])
    expect(
      (await collectScripts([SETUP, DEPLOY], [{ type: "add", path: DEPLOY }])).emitted,
    ).toEqual([[DEPLOY]])
  })

  it("emits once per burst, with every script written during it", async () => {
    const { emitted } = await collectScripts(
      [SETUP, DEPLOY, CHECK],
      [
        { type: "change", path: SETUP },
        { type: "change", path: DEPLOY },
        { type: "change", path: SETUP },
      ],
    )
    expect(emitted).toEqual([[SETUP, DEPLOY]])
  })

  it("ignores the other files in the scripts' directories, and deletions", async () => {
    const { emitted } = await collectScripts(
      [SETUP, CHECK],
      [
        { type: "change", path: "/work/my-runbook/runbook.mdx" },
        { type: "add", path: "/work/my-runbook/scripts/setup.sh.swp" },
        { type: "unlink", path: SETUP },
      ],
    )
    expect(emitted).toEqual([])
  })

  it("keeps a script change that is followed by unrelated writes in the same burst", async () => {
    const { emitted } = await collectScripts(
      [SETUP],
      [
        { type: "change", path: SETUP },
        { type: "add", path: "/work/my-runbook/scripts/notes.txt" },
      ],
    )
    expect(emitted).toEqual([[SETUP]])
  })

  it("matches a script's on-disk name case-insensitively on darwin, case-sensitively on linux", async () => {
    // Emitted as the registry spells it, whatever the file's name on disk.
    const event: FileChangeEvent = { type: "change", path: "/work/my-runbook/scripts/Setup.sh" }
    expect((await collectScripts([SETUP], [event], "darwin")).emitted).toEqual([[SETUP]])
    expect((await collectScripts([SETUP], [event], "linux")).emitted).toEqual([])
  })
})
