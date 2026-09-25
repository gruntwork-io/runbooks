import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// The IPC modules register handlers on electron's `ipcMain`. Capture them so
// the real handlers can be invoked without an Electron runtime.
//
// bun's mock.module is process-wide and the first mock of a module fixes the
// export names later importers link against, so every electron mock in the
// suite exports the same names (`app` and `ipcMain`; see theme-store.test.ts).
type Handler = (event: unknown, params?: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
mock.module("electron", () => ({
  app: {},
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    },
  },
}))

const { registerFileHandlers } = await import("./files.ts")
const { registerExecHandlers } = await import("./exec.ts")
const { resolveGeneratedDir } = await import("./path-guard.ts")
const runtimeModule = await import("./runtime.ts")
const { runtime, sessionManager, setRunbookConfig, setExecutableRegistry } = runtimeModule
const { ExecutableRegistry } = await import("../../../src/domain/registry/executable.ts")
const { DEFAULT_GENERATED_DIR } = await import("../../../src/domain/files/generated.ts")

registerFileHandlers()
registerExecHandlers()

const invoke = (channel: string, event: unknown, params?: unknown) => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler registered for ${channel}`)
  return handler(event, params)
}

/** Minimal `IpcMainInvokeEvent` stand-in: exec:run streams events via sender.send. */
const execEvent = () => {
  const sent: Array<{ channel: string; data: unknown }> = []
  const send = (channel: string, data: unknown) => sent.push({ channel, data })
  return { sent, event: { sender: { send } } }
}

describe("generated-files directory", () => {
  let tmp: string
  let runbookDir: string
  let elsewhereDir: string
  let generatedDir: string
  let executableId: string
  // runbookConfig is module-global and bun runs every test file in one
  // process: restore it so later files don't inherit the deleted temp runbook.
  let originalRunbookConfig: typeof runtimeModule.runbookConfig

  beforeEach(async () => {
    originalRunbookConfig = runtimeModule.runbookConfig
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "generated-dir-ipc-")))
    runbookDir = path.join(tmp, "runbook")
    elsewhereDir = path.join(tmp, "elsewhere")
    generatedDir = path.join(runbookDir, DEFAULT_GENERATED_DIR)
    fs.mkdirSync(path.join(runbookDir, "scripts"), { recursive: true })
    fs.mkdirSync(elsewhereDir)

    // A script that captures a file and then leaves the session somewhere
    // else, as `cd` into a cloned repo or a module directory would.
    fs.writeFileSync(
      path.join(runbookDir, "scripts", "capture-and-cd.sh"),
      [
        "#!/bin/bash",
        'echo captured > "$GENERATED_FILES/from-script.txt"',
        `cd '${elsewhereDir}'`,
        "",
      ].join("\n"),
    )
    const runbookPath = path.join(runbookDir, "runbook.mdx")
    fs.writeFileSync(
      runbookPath,
      '# Test\n\n<Command id="capture-and-cd" path="scripts/capture-and-cd.sh" />\n',
    )

    // Mirror runbook:get: config, a fresh session rooted at the realpath'd
    // runbook directory, and the executable registry.
    setRunbookConfig({ localPath: runbookPath, isWatchMode: false, useExecutableRegistry: true })
    await runtime.runPromise(sessionManager.createSession(runbookDir, runbookPath))
    const registry = await runtime.runPromise(ExecutableRegistry.create(runbookPath))
    setExecutableRegistry(registry)
    executableId = Object.values(registry.getAllExecutables()).find(
      (e) => e.componentId === "capture-and-cd",
    )!.id
  })

  afterEach(() => {
    sessionManager.deleteSession()
    setExecutableRegistry(null)
    setRunbookConfig(originalRunbookConfig)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("resolves the default next to the runbook, and an override relative to it", async () => {
    expect((await runtime.runPromise(resolveGeneratedDir())).absolutePath).toBe(generatedDir)
    expect((await runtime.runPromise(resolveGeneratedDir("custom/out"))).absolutePath).toBe(
      path.join(runbookDir, "custom", "out"),
    )
  })

  it("captures $GENERATED_FILES where render, check and delete look, even after the script cd's away", async () => {
    // A stale `generated/` under the directory the script cd's into must be
    // neither reported nor deleted.
    fs.mkdirSync(path.join(elsewhereDir, DEFAULT_GENERATED_DIR))
    fs.writeFileSync(path.join(elsewhereDir, DEFAULT_GENERATED_DIR, "not-ours.txt"), "keep")

    const { sent, event } = execEvent()
    const result = (await invoke("exec:run", event, { executableId })) as {
      status: { status: string } | null
    }
    expect(result.status?.status).toBe("success")
    expect(sent.some((e) => e.channel === "exec:files-captured")).toBe(true)

    // The script's cd moved the session; the capture still landed next to
    // the runbook, and a Template render (boilerplate:render resolves its
    // output through resolveGeneratedDir) would still write there too.
    expect((await runtime.runPromise(sessionManager.getSession())).workingDir).toBe(elsewhereDir)
    expect(fs.readFileSync(path.join(generatedDir, "from-script.txt"), "utf8").trim()).toBe(
      "captured",
    )
    expect((await runtime.runPromise(resolveGeneratedDir())).absolutePath).toBe(generatedDir)

    const checked = (await invoke("generated-files:check", {})) as {
      hasFiles: boolean
      absoluteOutputPath: string
      fileCount: number
    }
    expect(checked).toMatchObject({ hasFiles: true, absoluteOutputPath: generatedDir, fileCount: 1 })

    const deleted = (await invoke("generated-files:delete", {})) as { deletedCount: number }
    expect(deleted.deletedCount).toBe(1)
    expect(fs.readdirSync(generatedDir)).toEqual([])
    expect(fs.existsSync(path.join(elsewhereDir, DEFAULT_GENERATED_DIR, "not-ours.txt"))).toBe(true)
  })
})
