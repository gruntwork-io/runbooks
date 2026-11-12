/**
 * onepassword:create-item renders the block's templates in MAIN, then saves
 * the item with `op`. Only `electron`, the template engine and the `op`
 * process are replaced.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { mockElectron } from "../test-utils/mock-electron.ts"
import { ProcessSpawner } from "../../../src/services/ProcessSpawner.ts"
import { WasmRuntime } from "../../../src/services/WasmRuntime.ts"
import type { WasmRuntimeShape } from "../../../src/services/WasmRuntime.ts"
import { makeTestBoilerplate } from "../../../src/test-utils/TestLayer.ts"
import { makeTestEnvironment } from "../../../src/test-utils/TestEnvironment.ts"

type Handler = (event: unknown, params?: unknown) => unknown
const handlers = new Map<string, Handler>()
mockElectron({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    },
  },
})

const { registerOnePasswordHandlers } = await import("./onepassword.ts")
const { runtime } = await import("./runtime.ts")
registerOnePasswordHandlers()

const invoke = (params: unknown) =>
  Promise.resolve(handlers.get("onepassword:create-item")!({}, params)) as Promise<unknown>

/** `{{ .outputs.<block>.<name> }}` lookups, and a failure for anything else. */
const renderFileStrict = (template: string, vars: Record<string, unknown>) =>
  Effect.try({
    try: () =>
      template.replace(
        /\{\{\s*\.outputs\.(\w+)\.(\w+)\s*\}\}/g,
        (_m, block: string, name: string) => {
          const value = (vars.outputs as Record<string, Record<string, string>>)?.[block]?.[name]
          if (value === undefined) throw new Error(`map has no entry for key "${name}"`)
          return value
        },
      ),
    catch: (err) => err as never,
  })

describe("onepassword:create-item", () => {
  let stdin: string | undefined
  let argv: string[][]
  let runPromise: ReturnType<typeof spyOn<typeof runtime, "runPromise">>

  beforeEach(() => {
    stdin = undefined
    argv = []
    const spawner = Layer.succeed(ProcessSpawner, {
      spawn: (_command, args, options) =>
        Effect.sync(() => {
          argv.push(args)
          if (options?.stdin) stdin = options.stdin
          const line =
            args[1] === "list"
              ? "[]"
              : JSON.stringify({ id: "item1", title: "IAM", vault: { id: "v1", name: "Ops" } })
          return {
            output: Stream.make({ line, source: "stdout" as const }),
            exitCode: Effect.succeed(0),
            kill: Effect.void,
          }
        }),
    })
    const layer = Layer.mergeAll(
      spawner,
      makeTestEnvironment({}),
      makeTestBoilerplate({ renderFileStrict: renderFileStrict as never }),
      Layer.succeed(WasmRuntime, {} as WasmRuntimeShape),
    )
    runPromise = spyOn(runtime, "runPromise").mockImplementation(((
      effect: Effect.Effect<unknown, unknown, never>,
    ) => Effect.runPromise(Effect.provide(effect, layer) as Effect.Effect<unknown>)) as never)
  })

  afterEach(() => runPromise.mockRestore())

  it("renders outputs into the item, real values included, and replies with IDs only", async () => {
    const reply = await invoke({
      item: {
        vault: "Ops",
        title: "IAM",
        category: "API Credential",
        username: "{{ .outputs.iam.ACCESS_KEY_ID }}",
        password: "{{ .outputs.iam.SECRET_ACCESS_KEY }}",
      },
      templateInputs: {},
      templateOutputs: {
        iam: {
          ACCESS_KEY_ID: { value: "AKIA1", sensitive: false },
          SECRET_ACCESS_KEY: { value: "s3cr3t", sensitive: true },
        },
      },
    })
    expect(reply).toEqual({
      ok: true,
      itemId: "item1",
      title: "IAM",
      vaultId: "v1",
      vaultName: "Ops",
    })
    expect(JSON.parse(stdin!).fields).toEqual([
      { id: "username", type: "STRING", label: "username", value: "AKIA1" },
      { id: "credential", type: "CONCEALED", label: "credential", value: "s3cr3t" },
    ])
    expect(argv.flat()).not.toContain("s3cr3t")
  })

  it("fails, saving nothing, when a prop renders empty", async () => {
    const reply = await invoke({
      item: { vault: "Ops", title: "IAM", password: "{{ .outputs.iam.SECRET_ACCESS_KEY }}" },
      templateInputs: {},
      templateOutputs: { iam: { SECRET_ACCESS_KEY: { value: "", sensitive: true } } },
    })
    expect(reply).toEqual({
      ok: false,
      error:
        "password came out empty, so nothing was saved. Check that the outputs it reads have values.",
    })
    expect(argv).toEqual([])
  })

  it("refuses a sensitive output in a prop that goes on op's command line or into the outputs", async () => {
    const reply = await invoke({
      item: {
        vault: "Ops",
        title: "IAM {{ .outputs.iam.SECRET_ACCESS_KEY }}",
        url: "https://{{ .outputs.iam.SECRET_ACCESS_KEY }}.example.com",
        password: "{{ .outputs.iam.SECRET_ACCESS_KEY }}",
      },
      templateInputs: {},
      templateOutputs: { iam: { SECRET_ACCESS_KEY: { value: "s3cr3t", sensitive: true } } },
    })
    expect(reply).toEqual({
      ok: false,
      error:
        "itemTitle, url read a sensitive output, so nothing was saved. Only username, password, notes and field values can.",
    })
    expect(argv).toEqual([])
  })

  it("fails, naming the prop, when a template can't render", async () => {
    const reply = await invoke({
      item: { vault: "Ops", title: "IAM", password: "{{ .outputs.iam.MISSING }}" },
      templateInputs: {},
      templateOutputs: {},
    })
    expect(reply).toMatchObject({ ok: false })
    expect((reply as { error: string }).error).toContain("password")
    expect(argv).toEqual([])
  })
})
