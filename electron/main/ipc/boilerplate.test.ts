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
import { WasmError } from "../../../src/errors/index.ts"
import { hashTemplateDir } from "../../../src/domain/boilerplate/templateHash.ts"

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
const { installTestSessionPersistence } = await import("../test-utils/session-persistence.ts")
type TestSessionPersistence = ReturnType<typeof installTestSessionPersistence>

registerBoilerplateHandlers()

const TEMPLATE_ID = "app"

/** What the stub dispatcher returns, and what the handler did with it. */
interface Spy {
  warm: WarmRenderResult
  commits: Array<Record<string, unknown>>
  coldRenders: number
  /** What the cold subprocess writes, by path relative to its output dir. */
  coldFiles: Record<string, string>
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
/** A WASM runtime whose members die if called, but for the given ones. */
const wasmRuntime = (overrides: Partial<WasmRuntimeShape> = {}): WasmRuntimeShape => ({
  renderFiles: () => Effect.die("renderFiles not used"),
  prepareBundle: () => Effect.die("prepareBundle not used"),
  renderFilesWithHandle: () => Effect.die("renderFilesWithHandle not used"),
  releaseBundle: () => Effect.die("releaseBundle not used"),
  renderTemplate: () => Effect.die("renderTemplate not used"),
  isReady: Effect.die("isReady not used"),
  ...overrides,
})

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
      renderTemplate: (_templatePath, outDir) =>
        Effect.sync(() => {
          spy.coldRenders++
          for (const [relPath, content] of Object.entries(spy.coldFiles)) {
            fs.mkdirSync(path.dirname(path.join(outDir, relPath)), { recursive: true })
            fs.writeFileSync(path.join(outDir, relPath), content)
          }
        }),
    }),
    // Only reached for template-valued inputs, which these tests don't send.
    Layer.succeed(WasmRuntime, wasmRuntime()),
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

    spy = { warm: warmResult({}), commits: [], coldRenders: 0, coldFiles: {} }
    // The app runtime requires every service; these handlers use only what
    // testLayer provides, which the type of runFork can't express.
    spyOn(runtime, "runFork").mockImplementation(((
      effect: Effect.Effect<unknown, unknown, never>,
    ) =>
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
    // Messages as the WASM bridge returns them: the kind, then Go's
    // text/template error, which names the file by its base name.
    spy.warm = warmResult({
      files: [{ path: "ok.tf", content: "ok" }],
      coldNeeded: ["dynamic.tf"],
      renderErrors: [
        {
          path: "main.tf",
          kind: "render",
          message:
            'render: template: main.tf:3:5: executing "main.tf" at <.Foo>: map has no entry for key "Foo"',
        },
        {
          path: "modules/vars.tf",
          kind: "render",
          message: 'render: template: vars.tf:1: function "nope" not defined',
        },
        { path: "other.tf", kind: "render", message: "render: something else went wrong" },
      ],
      allKnownPaths: ["ok.tf", "dynamic.tf", "main.tf", "modules/vars.tf", "other.tf"],
      attemptedPaths: ["ok.tf", "dynamic.tf", "main.tf", "modules/vars.tf", "other.tf"],
    })

    const error = await render().then(
      () => {
        throw new Error("expected boilerplate:render to fail")
      },
      (err: unknown) => err as { _tag?: string; message: string },
    )

    expect(error._tag).toBe("RenderError")
    // Each file once, by its path, without the kind prefix.
    expect(error.message).toBe(
      "Template render failed: " +
        'main.tf:3:5: at <.Foo>: map has no entry for key "Foo"; ' +
        'modules/vars.tf:1: function "nope" not defined; ' +
        "other.tf: something else went wrong",
    )
    expect(spy.commits).toEqual([])
    expect(manifestStore.get(TEMPLATE_ID)).toBeUndefined()
    expect(fs.existsSync(path.join(generatedDir, "ok.tf"))).toBe(false)
    // The subprocess would hit the same template error, so it isn't run.
    expect(spy.coldRenders).toBe(0)
  })

  // A template like the Azure landing zone's: `identity/` is written only for
  // the "caf" layout, through `skip_files: [{ path: identity, if: '{{ ne
  // .Layout "caf" }}' }]`. `other.tf` doesn't depend on the layout.
  const CAF_PATHS = ["common.hcl", "identity/main.tf", "identity/nested/vars.tf", "other.tf"]
  const readGenerated = (relPath: string) =>
    fs.existsSync(path.join(generatedDir, relPath))
      ? fs.readFileSync(path.join(generatedDir, relPath), "utf8")
      : undefined

  describe("when a re-render stops producing files the last one wrote", () => {
    const renderCaf = async () => {
      spy.warm = warmResult({
        files: CAF_PATHS.map((p) => ({ path: p, content: `${p} caf` })),
        allKnownPaths: CAF_PATHS,
        attemptedPaths: CAF_PATHS,
      })
      await render()
      // A file the template never wrote, next to its output.
      fs.writeFileSync(path.join(generatedDir, "notes.md"), "mine")
      fs.writeFileSync(path.join(generatedDir, "identity", "mine.txt"), "mine")
    }

    it("deletes the files skip_files now excludes on the warm path", async () => {
      await renderCaf()

      // Layout changed to "single": the analyzer marks every file that
      // reads it dirty, and WASM reports identity/ as excluded.
      spy.warm = warmResult({
        files: [{ path: "common.hcl", content: "common.hcl single" }],
        skipped: ["identity/main.tf", "identity/nested/vars.tf"],
        allKnownPaths: CAF_PATHS,
        attemptedPaths: ["common.hcl", "identity/main.tf", "identity/nested/vars.tf"],
      })
      const result = (await render()) as { deletedFiles: string[]; skippedFiles: string[] }

      expect([...result.deletedFiles].sort()).toEqual([
        "identity/main.tf",
        "identity/nested/vars.tf",
      ])
      expect(readGenerated("common.hcl")).toBe("common.hcl single")
      expect(readGenerated("identity/main.tf")).toBeUndefined()
      expect(fs.existsSync(path.join(generatedDir, "identity", "nested"))).toBe(false)
      // Not re-rendered, so still produced and kept.
      expect(readGenerated("other.tf")).toBe("other.tf caf")
      expect(result.skippedFiles).toEqual(["other.tf"])
      // Files the template never wrote are left alone, and so is the
      // directory that still holds one.
      expect(readGenerated("notes.md")).toBe("mine")
      expect(readGenerated("identity/mine.txt")).toBe("mine")
      expect(manifestStore.get(TEMPLATE_ID)?.files.map((f) => f.path)).toEqual([
        "common.hcl",
        "other.tf",
      ])

      // Switching back writes them again.
      spy.warm = warmResult({
        files: ["common.hcl", "identity/main.tf", "identity/nested/vars.tf"].map((p) => ({
          path: p,
          content: `${p} caf`,
        })),
        allKnownPaths: CAF_PATHS,
        attemptedPaths: ["common.hcl", "identity/main.tf", "identity/nested/vars.tf"],
      })
      const back = (await render()) as { createdFiles: string[] }

      expect([...back.createdFiles].sort()).toEqual(["identity/main.tf", "identity/nested/vars.tf"])
      expect(readGenerated("identity/nested/vars.tf")).toBe("identity/nested/vars.tf caf")
      expect(manifestStore.get(TEMPLATE_ID)?.files.map((f) => f.path)).toEqual(CAF_PATHS)
    })

    it("deletes the files the cold render no longer writes", async () => {
      await renderCaf()

      // Warm is unavailable, so the subprocess renders the whole template,
      // and with the "single" layout skip_files keeps identity/ out of it.
      spy.warm = warmResult({ warmDisabled: true, disabledReason: "wasm-not-ready" })
      spy.coldFiles = { "common.hcl": "common.hcl single", "other.tf": "other.tf caf" }
      const result = (await render()) as { deletedFiles: string[] }

      expect(spy.coldRenders).toBe(1)
      expect([...result.deletedFiles].sort()).toEqual([
        "identity/main.tf",
        "identity/nested/vars.tf",
      ])
      expect(readGenerated("common.hcl")).toBe("common.hcl single")
      expect(readGenerated("identity/main.tf")).toBeUndefined()
      expect(fs.existsSync(path.join(generatedDir, "identity", "nested"))).toBe(false)
      expect(readGenerated("other.tf")).toBe("other.tf caf")
      expect(readGenerated("notes.md")).toBe("mine")
      expect(readGenerated("identity/mine.txt")).toBe("mine")
      expect(manifestStore.get(TEMPLATE_ID)?.files.map((f) => f.path)).toEqual([
        "common.hcl",
        "other.tf",
      ])
    })

    it("deletes them when part of the render falls back to cold", async () => {
      await renderCaf()

      // One dirty file needs the subprocess, which renders the whole
      // template; the warm half reports identity/ excluded.
      spy.warm = warmResult({
        coldNeeded: ["common.hcl"],
        skipped: ["identity/main.tf", "identity/nested/vars.tf"],
        allKnownPaths: CAF_PATHS,
        attemptedPaths: ["common.hcl", "identity/main.tf", "identity/nested/vars.tf"],
      })
      spy.coldFiles = { "common.hcl": "common.hcl single", "other.tf": "other.tf caf" }
      const result = (await render()) as { deletedFiles: string[] }

      expect([...result.deletedFiles].sort()).toEqual([
        "identity/main.tf",
        "identity/nested/vars.tf",
      ])
      expect(readGenerated("common.hcl")).toBe("common.hcl single")
      expect(fs.existsSync(path.join(generatedDir, "identity", "nested"))).toBe(false)
      expect(readGenerated("other.tf")).toBe("other.tf caf")
      expect(readGenerated("identity/mine.txt")).toBe("mine")
    })
  })

  // A variable the template misuses everywhere fails every file; the message
  // lists the first few and counts the rest.
  it("lists the first five failing files and counts the others", async () => {
    const paths = Array.from({ length: 8 }, (_, i) => `f${i + 1}.tf`)
    spy.warm = warmResult({
      renderErrors: paths.map((p) => ({
        path: p,
        kind: "render" as const,
        message: "render: boom",
      })),
      allKnownPaths: paths,
      attemptedPaths: paths,
    })

    const error = await render().then(
      () => {
        throw new Error("expected boilerplate:render to fail")
      },
      (err: unknown) => err as { message: string },
    )

    expect(error.message).toBe(
      "Template render failed: f1.tf: boom; f2.tf: boom; f3.tf: boom; f4.tf: boom; f5.tf: boom (and 3 more)",
    )
  })

  describe("in a saved session", () => {
    let sessions: TestSessionPersistence
    let sessionId: string

    const savedManifests = () =>
      runtime.runPromise(sessions.persistence.listTemplateManifests(sessionId))

    const restoreManifestsAsAfterRestart = async () => {
      manifestStore.clear()
      for (const saved of await savedManifests()) manifestStore.set(saved.templateId, saved)
    }

    const warmFiles = (files: Record<string, string>) =>
      warmResult({
        files: Object.entries(files).map(([filePath, content]) => ({ path: filePath, content })),
        allKnownPaths: Object.keys(files),
        attemptedPaths: Object.keys(files),
      })

    beforeEach(async () => {
      sessions = installTestSessionPersistence()
      const session = await runtime.runPromise(
        sessions.persistence.open({
          runbook: { path: path.join(tmp, "runbook.mdx"), remoteSource: undefined },
          launchDir: undefined,
          sessionId: undefined,
          startNew: false,
        }),
      )
      sessionId = session.id
      generatedDir = path.join(session.dir, DEFAULT_GENERATED_DIR)
    })

    afterEach(() => {
      sessions.cleanup()
    })

    it("saves each render's manifest to the session", async () => {
      spy.warm = warmFiles({ "main.tf": "ok" })

      await render()

      expect(manifestStore.get(TEMPLATE_ID)?.outputDir).toBe(generatedDir)
      expect(await savedManifests()).toEqual([manifestStore.get(TEMPLATE_ID)!])
    })

    it("keeps a later step's edit to an unchanged file after a restart", async () => {
      spy.warm = warmFiles({ "main.tf": "main v1", "vars.tf": "vars v1" })
      await render()
      fs.writeFileSync(path.join(generatedDir, "main.tf"), "main v1, edited by a later step")

      await restoreManifestsAsAfterRestart()
      spy.warm = warmFiles({ "main.tf": "main v1", "vars.tf": "vars v2" })
      const result = (await render()) as { createdFiles: string[]; modifiedFiles: string[] }

      expect(result.createdFiles).toEqual([])
      expect(result.modifiedFiles).toEqual(["vars.tf"])
      expect(fs.readFileSync(path.join(generatedDir, "main.tf"), "utf8")).toBe(
        "main v1, edited by a later step",
      )
      expect(fs.readFileSync(path.join(generatedDir, "vars.tf"), "utf8")).toBe("vars v2")
    })
  })
})

// Display only: the form asks what its linked values come to. The template
// engine is the boundary; this stand-in renders `{{ .Name }}` and
// `{{ .outputs.block.name }}` and fails on a missing key, as the WASM build does.
describe("boilerplate:resolve-inputs", () => {
  const renderTemplate = (template: string, varsJSON: string) => {
    const vars = JSON.parse(varsJSON) as Record<string, unknown> & {
      outputs: Record<string, Record<string, string>>
    }
    let missing: string | undefined
    const out = template.replace(/\{\{\s*\.([\w.]+)\s*\}\}/g, (_m, ref: string) => {
      const [first, block, name] = ref.split(".")
      const value = first === "outputs" ? vars.outputs[block!]?.[name!] : vars[first!]
      if (typeof value !== "string") missing ??= ref
      return String(value)
    })
    return missing
      ? Effect.fail(
          new WasmError({ message: `map has no entry for key "${missing}"`, kind: "internal" }),
        )
      : Effect.succeed(out)
  }

  beforeEach(() => {
    // As runFork above: the handler needs only the WASM runtime of the app's services.
    spyOn(runtime, "runPromise").mockImplementation(((effect: Effect.Effect<unknown, unknown>) =>
      Effect.runPromise(
        Effect.provide(
          effect,
          Layer.succeed(WasmRuntime, wasmRuntime({ renderTemplate })),
        ) as Effect.Effect<unknown>,
      )) as unknown as typeof runtime.runPromise)
  })

  afterEach(() => {
    mock.restore()
  })

  it("resolves each linked value against the other inputs and the outputs", async () => {
    const result = await handlers.get("boilerplate:resolve-inputs")!(null, {
      inputs: {
        ProjectName: "acme",
        BucketName: "{{ .ProjectName }}-state",
        Repos: ["github.com/{{ .ProjectName }}/modules"],
        AccountId: "{{ .outputs.make_account.account_id }}",
      },
      outputs: { make_account: { account_id: "123456789012" } },
    })

    expect(result).toEqual({
      inputs: {
        ProjectName: "acme",
        BucketName: "acme-state",
        Repos: ["github.com/acme/modules"],
        AccountId: "123456789012",
      },
    })
  })

  it("returns a value that doesn't resolve as it was sent", async () => {
    const result = await handlers.get("boilerplate:resolve-inputs")!(null, {
      inputs: { DbUrl: "postgres://app:{{ .DbPassword }}@db" },
    })

    expect(result).toEqual({ inputs: { DbUrl: "postgres://app:{{ .DbPassword }}@db" } })
  })
})

describe("boilerplate:variables", () => {
  let tmp: string
  let originalRunbookConfig: typeof runtimeModule.runbookConfig

  const variables = (params: Record<string, unknown>) =>
    handlers.get("boilerplate:variables")!(null, params) as Promise<{ contentHash?: string }>

  beforeEach(async () => {
    originalRunbookConfig = runtimeModule.runbookConfig
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "boilerplate-variables-ipc-")))
    fs.mkdirSync(path.join(tmp, "templates", "app"), { recursive: true })
    fs.writeFileSync(path.join(tmp, "templates", "app", "boilerplate.yml"), "variables: []\n")
    fs.writeFileSync(path.join(tmp, "templates", "app", "main.tf"), "# v1\n")
    const runbookPath = path.join(tmp, "runbook.mdx")
    fs.writeFileSync(runbookPath, "# Test\n")
    setRunbookConfig({ ...originalRunbookConfig, localPath: runbookPath, isWatchMode: false })
    await runtime.runPromise(sessionManager.createSession(tmp, runbookPath))
  })

  afterEach(() => {
    sessionManager.deleteSession()
    setRunbookConfig(originalRunbookConfig)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("hashes the template's files, so a change to one shows", async () => {
    const before = (await variables({ templatePath: "templates/app" })).contentHash
    expect(before).toBe(
      await Effect.runPromise(
        hashTemplateDir(path.join(tmp, "templates", "app")).pipe(
          Effect.provide(NodeFileSystemLive),
        ),
      ),
    )

    fs.writeFileSync(path.join(tmp, "templates", "app", "main.tf"), "# v2\n")

    expect((await variables({ templatePath: "templates/app" })).contentHash).not.toBe(before)
  })

  it("has no hash for inline boilerplate, which has no files", async () => {
    const config = await variables({ boilerplateContent: "variables: []\n" })

    expect(config.contentHash).toBeUndefined()
  })
})
