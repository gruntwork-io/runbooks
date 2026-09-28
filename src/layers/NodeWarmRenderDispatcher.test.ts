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

/**
 * Inputs map with real per-file dependencies: `name.txt` reads Name,
 * `region.txt` reads Region, `both.txt` reads both, `static.txt` reads
 * nothing. Keys follow the analyzer's "<templatePath>:<inputName>" shape.
 */
function varsDiffInputsMap(): InputsMapResult {
  return {
    inputs: {
      "t:Name": { name: "Name" },
      "t:Region": { name: "Region" },
    },
    files: {
      "name.txt": ["t:Name"],
      "region.txt": ["t:Region"],
      "both.txt": ["t:Name", "t:Region"],
      "static.txt": [],
    },
  } as unknown as InputsMapResult
}

interface BundleSpy {
  /** templatePath of every bundle actually built (cache misses). */
  builtPaths: string[]
}

/**
 * Caches by templateId alone, like NodeBundleProducer — so a render that
 * gets a fresh bundle for a new path proves the dispatcher invalidated it.
 */
function fakeBundleLayer(inputsMap: InputsMapResult, bundleSpy: BundleSpy) {
  const cache = new Map<string, BundleArtifact>()
  const impl: BundleProducerShape = {
    get: (templateId, templatePath) =>
      Effect.sync(() => {
        const cached = cache.get(templateId)
        if (cached) return cached
        bundleSpy.builtPaths.push(templatePath)
        const artifact: BundleArtifact = {
          templateId,
          templatePath,
          inputsMap,
          bundleJSON: JSON.stringify({ rootPath: templatePath }),
          producedAt: 0,
        }
        cache.set(templateId, artifact)
        return artifact
      }),
    clear: Effect.sync(() => cache.clear()),
    invalidate: (templateId) =>
      Effect.sync(() => {
        cache.delete(templateId)
      }),
  }
  return Layer.succeed(BundleProducer, impl)
}

interface WasmSpy {
  prepareCalls: number
  releasedHandles: string[]
  /** bundleJSON passed to each prepareBundle call, in order. */
  preparedBundles?: string[]
}

function fakeWasmLayer(spy: WasmSpy) {
  let nextHandle = 0
  const renderAll = (paths: ReadonlyArray<string>): WasmRenderFilesResult => ({
    results: paths.map((path) => ({ path, content: `rendered:${path}` })),
  })
  const impl: WasmRuntimeShape = {
    isReady: Effect.succeed(true),
    prepareBundle: (bundleJSON) =>
      Effect.sync(() => {
        spy.prepareCalls++
        spy.preparedBundles?.push(bundleJSON)
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

function makeDispatcher(
  spy: WasmSpy,
  inputsMap: InputsMapResult,
  bundleSpy: BundleSpy,
) {
  return NodeWarmRenderDispatcherLive.pipe(
    Layer.provide(fakeBundleLayer(inputsMap, bundleSpy)),
    Layer.provide(fakeWasmLayer(spy)),
  )
}

const run = <A>(
  spy: WasmSpy,
  f: (d: WarmRenderDispatcherShape) => Effect.Effect<A, unknown, never>,
  inputsMap: InputsMapResult = fakeInputsMap(),
  bundleSpy: BundleSpy = { builtPaths: [] },
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const d = yield* WarmRenderDispatcher
      return yield* f(d)
    }).pipe(
      Effect.provide(makeDispatcher(spy, inputsMap, bundleSpy)),
    ) as Effect.Effect<A, never, never>,
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
        // 1. First render prepares a handle and renders the world; the
        //    caller commits once the output is on disk.
        const first = yield* d.render(templateId, "/tmp/template", vars)
        expect(first.noChanges).toBe(false)
        expect(first.attemptedPaths).toEqual(KNOWN_PATHS)
        expect(spy.prepareCalls).toBe(1)
        yield* d.commit(templateId, vars)

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

describe("NodeWarmRenderDispatcher vars baseline", () => {
  let spy: WasmSpy
  beforeEach(() => {
    spy = { prepareCalls: 0, releasedHandles: [] }
  })

  const V0 = { Name: "api", Region: "us-east-1", outputs: {} }
  const V1 = { ...V0, Name: "web" }
  const V2 = { ...V1, Region: "eu-west-1" }

  it("renders only the files that read a changed var", async () => {
    const templateId = freshTemplateId()
    await run(
      spy,
      (d) =>
        Effect.gen(function* () {
          yield* d.render(templateId, "/tmp/template", V0)
          yield* d.commit(templateId, V0)

          const result = yield* d.render(templateId, "/tmp/template", V1)
          expect(result.noChanges).toBe(false)
          expect([...result.attemptedPaths].sort()).toEqual(["both.txt", "name.txt"])
        }),
      varsDiffInputsMap(),
    )
  })

  it("keeps an uncommitted change dirty for the next render", async () => {
    const templateId = freshTemplateId()
    await run(
      spy,
      (d) =>
        Effect.gen(function* () {
          yield* d.render(templateId, "/tmp/template", V0)
          yield* d.commit(templateId, V0)

          // The V1 render is superseded (or fails) before its output is
          // written, so the caller never commits it.
          yield* d.render(templateId, "/tmp/template", V1)

          // V2 only changes Region relative to V1, but disk still holds V0,
          // so the Name files must be re-rendered too.
          const result = yield* d.render(templateId, "/tmp/template", V2)
          expect([...result.attemptedPaths].sort()).toEqual([
            "both.txt",
            "name.txt",
            "region.txt",
          ])
        }),
      varsDiffInputsMap(),
    )
  })

  it("diffs against the committed vars once the caller commits", async () => {
    const templateId = freshTemplateId()
    await run(
      spy,
      (d) =>
        Effect.gen(function* () {
          yield* d.render(templateId, "/tmp/template", V0)
          yield* d.commit(templateId, V0)
          yield* d.render(templateId, "/tmp/template", V1)
          yield* d.commit(templateId, V1)

          const result = yield* d.render(templateId, "/tmp/template", V2)
          expect([...result.attemptedPaths].sort()).toEqual(["both.txt", "region.txt"])
        }),
      varsDiffInputsMap(),
    )
  })

  it("does not report noChanges for identical vars that were never committed", async () => {
    const templateId = freshTemplateId()
    await run(spy, (d) =>
      Effect.gen(function* () {
        yield* d.render(templateId, "/tmp/template", V0)
        const again = yield* d.render(templateId, "/tmp/template", V0)
        expect(again.noChanges).toBe(false)
        expect(again.attemptedPaths).toEqual(KNOWN_PATHS)
      }),
    )
  })
})

describe("NodeWarmRenderDispatcher template path changes", () => {
  let spy: WasmSpy
  let bundleSpy: BundleSpy
  beforeEach(() => {
    spy = { prepareCalls: 0, releasedHandles: [], preparedBundles: [] }
    bundleSpy = { builtPaths: [] }
  })

  const vars = { Foo: "bar", outputs: {} }

  it("rebuilds the bundle and handle when the same id points at a different template", async () => {
    const templateId = freshTemplateId()
    await run(
      spy,
      (d) =>
        Effect.gen(function* () {
          yield* d.render(templateId, "/runbook-a/templates/vpc", vars)
          yield* d.commit(templateId, vars)
          const same = yield* d.render(templateId, "/runbook-a/templates/vpc", vars)
          expect(same.noChanges).toBe(true)

          // Same id and identical vars, but another runbook's template (or
          // an edited `path` prop): this is a first render, not a no-op.
          const moved = yield* d.render(templateId, "/runbook-b/templates/db", vars)
          expect(moved.noChanges).toBe(false)
          expect(moved.attemptedPaths).toEqual(KNOWN_PATHS)
          expect(bundleSpy.builtPaths).toEqual([
            "/runbook-a/templates/vpc",
            "/runbook-b/templates/db",
          ])
          expect(spy.releasedHandles).toEqual(["handle-0"])
          expect(spy.preparedBundles).toEqual([
            JSON.stringify({ rootPath: "/runbook-a/templates/vpc" }),
            JSON.stringify({ rootPath: "/runbook-b/templates/db" }),
          ])
        }),
      fakeInputsMap(),
      bundleSpy,
    )
  })

  it("drops state a render left behind after reset()", async () => {
    const templateId = freshTemplateId()
    await run(
      spy,
      (d) =>
        Effect.gen(function* () {
          yield* d.render(templateId, "/tmp/template", vars)
          yield* d.reset
          // A render that was in flight across the reset finishes and
          // commits for the old runbook.
          yield* d.commit(templateId, vars)

          const next = yield* d.render(templateId, "/tmp/template", vars)
          expect(next.noChanges).toBe(false)
          expect(next.attemptedPaths).toEqual(KNOWN_PATHS)
        }),
      fakeInputsMap(),
      bundleSpy,
    )
  })
})
