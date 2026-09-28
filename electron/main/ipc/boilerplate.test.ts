import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Layer } from "effect"
import { mockElectron } from "../test-utils/mock-electron.ts"
import { NodeFileSystemLive } from "../../../src/layers/NodeFileSystem.ts"
import { BoilerplateRenderer } from "../../../src/services/BoilerplateRenderer.ts"
import { WasmRuntime, type WasmRuntimeShape } from "../../../src/services/WasmRuntime.ts"
import {
  WarmRenderDispatcher,
  type WarmRenderResult,
} from "../../../src/services/WarmRenderDispatcher.ts"
import { DEFAULT_GENERATED_DIR } from "../../../src/domain/files/generated.ts"

// boilerplate.ts registers its handlers on electron's ipcMain. Capture them so
// the real boilerplate:render handler can be called directly.
type Handler = (event: unknown, params?: unknown) => Promise<unknown>
const handlers = new Map<string, Handler>()
mockElectron({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    },
  },
})

const { registerBoilerplateHandlers } = await import("./boilerplate.ts")
const runtimeModule = await import("./runtime.ts")
const { runtime, sessionManager, manifestStore, setRunbookConfig } = runtimeModule

registerBoilerplateHandlers()

const TEMPLATE_ID = "app"

/** What the stub dispatcher returns, and what the handler did with it. */
interface Spy {
  warm: WarmRenderResult
  commits: Array<Record<string, unknown>>
  coldRenders: number
}

const warmResult = (overrides: Partial<WarmRenderResult>): WarmRenderResult => ({
  files: [],
  coldNeeded: [],
  skipped: [],
  renderErrors: [],
  warmDisabled: false,
  allKnownPaths: [],
  attemptedPaths: [],
  noChanges: false,
  ...overrides,
})

// The real FileSystem, so writes land on disk; the warm dispatcher and the
// cold subprocess renderer are the boundaries (the backend test run does not
// fetch the vendored boilerplate binary or WASM module).
const testLayer = (spy: Spy) =>
  Layer.mergeAll(
    NodeFileSystemLive,
    Layer.succeed(WarmRenderDispatcher, {
      render: () => Effect.succeed(spy.warm),
      commit: (_templateId, variables) => Effect.sync(() => void spy.commits.push(variables)),
      reset: Effect.void,
      invalidate: () => Effect.void,
    }),
    Layer.succeed(BoilerplateRenderer, {
      renderFile: () => Effect.die("renderFile not used"),
      renderFileStrict: () => Effect.die("renderFileStrict not used"),
      renderTemplate: () => Effect.sync(() => void spy.coldRenders++),
    }),
    // Only reached for template-valued inputs, which these tests don't send.
    Layer.succeed(WasmRuntime, {} as WasmRuntimeShape),
  )

describe("boilerplate:render", () => {
  let tmp: string
  let generatedDir: string
  let spy: Spy
  let originalRunbookConfig: typeof runtimeModule.runbookConfig

  const render = () =>
    handlers.get("boilerplate:render")!(null, {
      templatePath: "templates/app",
      templateId: TEMPLATE_ID,
      variables: { inputs: { Name: "x" } },
    })

  beforeEach(async () => {
    originalRunbookConfig = runtimeModule.runbookConfig
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "boilerplate-render-ipc-")))
    generatedDir = path.join(tmp, DEFAULT_GENERATED_DIR)
    fs.mkdirSync(path.join(tmp, "templates", "app"), { recursive: true })
    fs.writeFileSync(path.join(tmp, "templates", "app", "boilerplate.yml"), "variables: []\n")
    const runbookPath = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(runbookPath, "# Test\n")
    setRunbookConfig({ ...originalRunbookConfig, localPath: runbookPath, isWatchMode: false })
    await runtime.runPromise(sessionManager.createSession(tmp, runbookPath))

    spy = { warm: warmResult({}), commits: [], coldRenders: 0 }
    spyOn(runtime, "runFork").mockImplementation(((effect: Effect.Effect<unknown, unknown, never>) =>
      Effect.runFork(Effect.provide(effect, testLayer(spy)))) as unknown as typeof runtime.runFork)
  })

  afterEach(() => {
    mock.restore()
    manifestStore.delete(TEMPLATE_ID)
    sessionManager.deleteSession()
    setRunbookConfig(originalRunbookConfig)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("writes the warm output, stores its manifest and commits the vars", async () => {
    spy.warm = warmResult({
      files: [{ path: "main.tf", content: "ok" }],
      allKnownPaths: ["main.tf"],
      attemptedPaths: ["main.tf"],
    })

    const result = (await render()) as { createdFiles: string[] }

    expect(result.createdFiles).toEqual(["main.tf"])
    expect(fs.readFileSync(path.join(generatedDir, "main.tf"), "utf8")).toBe("ok")
    expect(manifestStore.get(TEMPLATE_ID)?.files.map((f) => f.path)).toEqual(["main.tf"])
    expect(spy.commits).toHaveLength(1)
  })

  // Like the cold path, where the boilerplate subprocess exits non-zero: the
  // render fails and nothing is written. Not committing matters most: the next
  // render (a retry with the same values) must not hit the no-change shortcut.
  it("fails with each file's template error and writes, stores and commits nothing", async () => {
    spy.warm = warmResult({
      files: [{ path: "ok.tf", content: "ok" }],
      coldNeeded: ["dynamic.tf"],
      renderErrors: [
        { path: "main.tf", kind: "render", message: 'map has no entry for key "Foo"' },
        { path: "vars.tf", kind: "render", message: 'function "nope" not defined' },
      ],
      allKnownPaths: ["ok.tf", "dynamic.tf", "main.tf", "vars.tf"],
      attemptedPaths: ["ok.tf", "dynamic.tf", "main.tf", "vars.tf"],
    })

    const error = await render().then(
      () => { throw new Error("expected boilerplate:render to fail") },
      (err: unknown) => err as { _tag?: string; message: string },
    )

    expect(error._tag).toBe("RenderError")
    expect(error.message).toContain('main.tf: map has no entry for key "Foo"')
    expect(error.message).toContain('vars.tf: function "nope" not defined')
    expect(spy.commits).toEqual([])
    expect(manifestStore.get(TEMPLATE_ID)).toBeUndefined()
    expect(fs.existsSync(path.join(generatedDir, "ok.tf"))).toBe(false)
    // The subprocess would hit the same template error, so it isn't run.
    expect(spy.coldRenders).toBe(0)
  })
})
