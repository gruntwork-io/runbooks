import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { makeRunbookWatcher, makeScriptWatcher, type RunbookWatcher } from "./runbook-watcher.ts"
import { FileSystem, type FileChangeEvent } from "../../../src/services/FileSystem.ts"
import { FileWatchError } from "../../../src/errors/index.ts"
import { makeTestFileSystem } from "../../../src/test-utils/TestFileSystem.ts"

// A FileSystem whose watch() streams stay open until interrupted, recording
// which paths were opened, how many streams were closed, and an emitter per
// stream so tests can push file events into it.
let opened: string[][] = []
let closed = 0
let emitters: Array<(event: FileChangeEvent) => void> = []

const watchRuntime = ManagedRuntime.make(
  Layer.effect(
    FileSystem,
    Effect.map(FileSystem, (fs) => ({
      ...fs,
      watch: (paths: string[]) =>
        Stream.async<FileChangeEvent, FileWatchError>((emit) => {
          opened.push(paths)
          emitters.push((event) => void emit.single(event))
          return Effect.sync(() => {
            closed++
          })
        }),
    })),
  ).pipe(Layer.provide(makeTestFileSystem())),
)

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
  }
}

const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 20)
  })

let reloads: string[] = []
let watcher: RunbookWatcher

beforeEach(() => {
  opened = []
  closed = 0
  emitters = []
  reloads = []
  watcher = makeRunbookWatcher(watchRuntime, (runbookPath) => {
    reloads.push(runbookPath)
  })
})

afterEach(async () => {
  await watcher.stop()
})

const failingRuntime = ManagedRuntime.make(
  Layer.effect(
    FileSystem,
    Effect.map(FileSystem, (fs) => ({
      ...fs,
      watch: (paths: string[]) => {
        opened.push(paths)
        return Stream.fail(new FileWatchError({ cause: "watcher limit reached" }))
      },
    })),
  ).pipe(Layer.provide(makeTestFileSystem())),
)

afterAll(async () => {
  await Promise.all([watchRuntime.dispose(), failingRuntime.dispose()])
})

describe("makeRunbookWatcher", () => {
  it("keeps one watcher per runbook: starting the same runbook again is a no-op", async () => {
    watcher.start("/work/a/runbook.mdx")
    await waitFor(() => opened.length === 1)

    watcher.start("/work/a/runbook.mdx")
    await settle()

    expect(opened).toEqual([["/work/a"]])
    expect(closed).toBe(0)
  })

  it("interrupts the previous watcher when a different runbook is watched", async () => {
    watcher.start("/work/a/runbook.mdx")
    await waitFor(() => opened.length === 1)

    watcher.start("/work/b/runbook.mdx")
    await waitFor(() => opened.length === 2 && closed === 1)

    expect(opened[1]).toEqual(["/work/b"])
  })

  it("stop closes the file watcher and resolves once it is closed", async () => {
    watcher.start("/work/a/runbook.mdx")
    await waitFor(() => opened.length === 1)

    await watcher.stop()
    expect(closed).toBe(1)

    // Watching again after a stop starts a fresh watcher.
    watcher.start("/work/a/runbook.mdx")
    await waitFor(() => opened.length === 2)
  })

  it("reloads the runbook once per debounced change to its file", async () => {
    watcher.start("/work/a/runbook.mdx")
    await waitFor(() => emitters.length === 1)

    emitters[0]!({ type: "change", path: "/work/a/generated/out.txt" })
    emitters[0]!({ type: "change", path: "/work/a/runbook.mdx" })
    emitters[0]!({ type: "change", path: "/work/a/runbook.mdx" })
    await waitFor(() => reloads.length > 0)
    await new Promise((resolve) => {
      setTimeout(resolve, 400)
    })

    expect(reloads).toEqual(["/work/a/runbook.mdx"])
  })

  it("drops a pending change once the watcher is stopped", async () => {
    watcher.start("/work/a/runbook.mdx")
    await waitFor(() => emitters.length === 1)

    emitters[0]!({ type: "change", path: "/work/a/runbook.mdx" })
    await watcher.stop()
    await new Promise((resolve) => {
      setTimeout(resolve, 400)
    })

    expect(reloads).toEqual([])
  })

  it("replaces a watcher that failed instead of treating it as still running", async () => {
    // The failure is logged as a warning; keep it out of the test output.
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const failing = makeRunbookWatcher(failingRuntime, () => {})
    try {
      failing.start("/work/a/runbook.mdx")
      await waitFor(() => opened.length === 1 && warn.mock.calls.length === 1)
      await settle()

      failing.start("/work/a/runbook.mdx")
      await waitFor(() => opened.length === 2)

      expect(opened).toEqual([["/work/a"], ["/work/a"]])
      expect(String(warn.mock.calls[0]![1])).toContain("stopped watching /work/a/runbook.mdx")
    } finally {
      await failing.stop()
      warn.mockRestore()
    }
  })
})

describe("makeScriptWatcher", () => {
  const SETUP = "/work/a/scripts/setup.sh"
  const DEPLOY = "/work/a/scripts/deploy.sh"

  let changes: string[][] = []
  const scripts = makeScriptWatcher(watchRuntime, (scriptsWritten) => {
    changes.push(scriptsWritten)
  })

  beforeEach(() => {
    changes = []
  })

  afterEach(async () => {
    await scripts.stop()
  })

  it("keeps one watcher per set of scripts, in any order", async () => {
    scripts.watch([SETUP, DEPLOY])
    await waitFor(() => opened.length === 1)

    scripts.watch([DEPLOY, SETUP])
    await settle()

    expect(opened).toEqual([["/work/a/scripts"]])
    expect(closed).toBe(0)
  })

  it("replaces the watcher when the set of scripts changes, and stops it for an empty set", async () => {
    scripts.watch([SETUP])
    await waitFor(() => opened.length === 1)

    scripts.watch([SETUP, "/work/a/check.sh"])
    await waitFor(() => opened.length === 2 && closed === 1)
    expect(opened[1]).toEqual(["/work/a/scripts", "/work/a"])

    scripts.watch([])
    await waitFor(() => closed === 2)
    expect(opened).toHaveLength(2)
  })

  it("reports once per debounced burst, with the watched scripts written during it", async () => {
    scripts.watch([SETUP, DEPLOY, "/work/a/scripts/untouched.sh"])
    await waitFor(() => emitters.length === 1)

    emitters[0]!({ type: "change", path: "/work/a/scripts/notes.txt" })
    emitters[0]!({ type: "change", path: SETUP })
    emitters[0]!({ type: "change", path: DEPLOY })
    await waitFor(() => changes.length > 0)
    await new Promise((resolve) => {
      setTimeout(resolve, 400)
    })

    expect(changes).toEqual([[SETUP, DEPLOY]])

    // The next burst starts empty: it reports only what it wrote.
    emitters[0]!({ type: "change", path: DEPLOY })
    await waitFor(() => changes.length > 1)
    expect(changes[1]).toEqual([DEPLOY])
  })
})
