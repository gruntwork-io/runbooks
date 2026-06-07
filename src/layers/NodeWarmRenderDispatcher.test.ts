import { describe, it, expect, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import {
  WarmRenderDispatcher,
  type WarmRenderDispatcherShape,
} from "../services/WarmRenderDispatcher.ts"
import {
  BundleProducer,
  type BundleProducerShape,
  type BundleArtifact,
} from "../services/BundleProducer.ts"
import { WasmRuntime } from "../services/WasmRuntime.ts"
import type {
  WasmRuntimeShape,
  WasmRenderFilesResult,
  InputsMapResult,
} from "../services/WasmRuntime.ts"
import { NodeWarmRenderDispatcherLive } from "./NodeWarmRenderDispatcher.ts"

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const KNOWN_PATHS = ["a.txt", "b.txt"]

function fakeInputsMap(): InputsMapResult {
  // No declared input deps — the dirty-set computation only cares about the
  // `outputs` namespace + root-name diff for these tests.
  return {
    inputs: {},
    files: Object.fromEntries(KNOWN_PATHS.map((p) => [p, []])),
  } as unknown as InputsMapResult
}

function fakeBundleLayer() {
  const artifact: BundleArtifact = {
    templateId: "ignored",
    templatePath: "/tmp/template",
    inputsMap: fakeInputsMap(),
    bundleJSON: "{}",
    producedAt: 0,
  }
  const impl: BundleProducerShape = {
    get: (templateId, templatePath) =>
      Effect.succeed({ ...artifact, templateId, templatePath }),
    clear: Effect.void,
    invalidate: () => Effect.void,
  }
  return Layer.succeed(BundleProducer, impl)
}

interface WasmSpy {
  prepareCalls: number
  releasedHandles: string[]
}

function fakeWasmLayer(spy: WasmSpy) {
  let nextHandle = 0
  const renderAll = (paths: ReadonlyArray<string>): WasmRenderFilesResult => ({
    results: paths.map((path) => ({ path, content: `rendered:${path}` })),
  })
  const impl: WasmRuntimeShape = {
    isReady: Effect.succeed(true),
    prepareBundle: () =>
      Effect.sync(() => {
        spy.prepareCalls++
        return `handle-${nextHandle++}`
      }),
    renderFilesWithHandle: (_handle, paths) => Effect.succeed(renderAll(paths)),
    renderFiles: (_bundleJSON, paths) => Effect.succeed(renderAll(paths)),
    releaseBundle: (handle) =>
      Effect.sync(() => {
        spy.releasedHandles.push(handle)
      }),
    renderTemplate: () => Effect.die("renderTemplate not implemented"),
  }
  return Layer.succeed(WasmRuntime, impl)
}

function makeDispatcher(spy: WasmSpy) {
  return NodeWarmRenderDispatcherLive.pipe(
    Layer.provide(fakeBundleLayer()),
    Layer.provide(fakeWasmLayer(spy)),
  )
}

const run = <A>(
  spy: WasmSpy,
  f: (d: WarmRenderDispatcherShape) => Effect.Effect<A, unknown, never>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const d = yield* WarmRenderDispatcher
      return yield* f(d)
    }).pipe(Effect.provide(makeDispatcher(spy))) as Effect.Effect<A, never, never>,
  )

// Unique templateId per test keeps the module-scoped caches
// (previousVarsByTemplate / handlesByTemplate) from leaking between tests.
let counter = 0
function freshTemplateId(): string {
  return `tmpl-${counter++}`
}

describe("NodeWarmRenderDispatcher.invalidate", () => {
  let spy: WasmSpy
  beforeEach(() => {
    spy = { prepareCalls: 0, releasedHandles: [] }
  })

  it("releases the prepared handle and clears cached vars so the next render is a first-render", async () => {
    const templateId = freshTemplateId()
    const vars = { Foo: "bar", inputs: { Foo: "bar" }, outputs: {} }

    await run(spy, (d) =>
      Effect.gen(function* () {
        // 1. First render seeds prevVars + prepares a handle, rendering the world.
        const first = yield* d.render(templateId, "/tmp/template", vars)
        expect(first.noChanges).toBe(false)
        expect(first.attemptedPaths).toEqual(KNOWN_PATHS)
        expect(spy.prepareCalls).toBe(1)

        // 2. Same vars again → dirty set empty → no-op (proves prevVars cached).
        const second = yield* d.render(templateId, "/tmp/template", vars)
        expect(second.noChanges).toBe(true)
        expect(spy.prepareCalls).toBe(1)
        expect(spy.releasedHandles).toEqual([])

        // 3. Invalidate: should release the handle and drop cached vars.
        yield* d.invalidate(templateId)
        expect(spy.releasedHandles).toEqual(["handle-0"])

        // 4. Same vars once more → treated as first-render again (everything
        //    dirty) and a new handle is prepared.
        const third = yield* d.render(templateId, "/tmp/template", vars)
        expect(third.noChanges).toBe(false)
        expect(third.attemptedPaths).toEqual(KNOWN_PATHS)
        expect(spy.prepareCalls).toBe(2)
      }),
    )
  })

  it("is a no-op when the templateId was never rendered", async () => {
    const templateId = freshTemplateId()
    await run(spy, (d) => d.invalidate(templateId))
    expect(spy.releasedHandles).toEqual([])
  })
})
