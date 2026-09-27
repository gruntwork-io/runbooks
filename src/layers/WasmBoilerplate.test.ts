import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect, Either, Layer } from "effect"
import { RenderError, WasmError } from "../errors/index.ts"
import { resolveBoilerplateBinary, WasmBoilerplateLive } from "./WasmBoilerplate.ts"
import { BoilerplateRenderer } from "../services/BoilerplateRenderer.ts"
import type { BoilerplateRendererShape } from "../services/BoilerplateRenderer.ts"
import { WasmRuntime } from "../services/WasmRuntime.ts"
import type { WasmRuntimeShape } from "../services/WasmRuntime.ts"
import { makeTestFileSystem } from "../test-utils/TestFileSystem.ts"
import { makeTestSpawner } from "../test-utils/TestSpawner.ts"

// The main process always points BOILERPLATE_BIN at the vendored copy before
// any render. An unset var is a wiring bug and must fail — never fall back to
// a `boilerplate` on PATH, which could be any version.
describe("resolveBoilerplateBinary", () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.BOILERPLATE_BIN
  })

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.BOILERPLATE_BIN
    } else {
      process.env.BOILERPLATE_BIN = saved
    }
  })

  it("returns BOILERPLATE_BIN when set", async () => {
    process.env.BOILERPLATE_BIN = "/app/resources/bin/boilerplate"
    const bin = await Effect.runPromise(resolveBoilerplateBinary())
    expect(bin).toBe("/app/resources/bin/boilerplate")
  })

  it("fails with RenderError instead of falling back to PATH when unset", async () => {
    delete process.env.BOILERPLATE_BIN
    const result = await Effect.runPromise(Effect.either(resolveBoilerplateBinary()))
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(RenderError)
      expect(result.left.message).toContain("BOILERPLATE_BIN is not set")
    }
  })

  it("treats an empty BOILERPLATE_BIN as unset", async () => {
    process.env.BOILERPLATE_BIN = ""
    const result = await Effect.runPromise(Effect.either(resolveBoilerplateBinary()))
    expect(Either.isLeft(result)).toBe(true)
  })
})

// renderFile is the lenient preview render; renderFileStrict backs Command/
// Check execution and must never hand back a `[template error: ...]` marker
// as if it were the rendered script.
describe("WasmBoilerplateLive single-string renders", () => {
  function rendererOver(renderTemplate: WasmRuntimeShape["renderTemplate"]) {
    const notImplemented = (name: string) =>
      Effect.die(`fake WasmRuntime: ${name} not implemented in WasmBoilerplate.test`)
    const wasm: WasmRuntimeShape = {
      renderTemplate,
      renderFiles: () => notImplemented("renderFiles") as never,
      prepareBundle: () => notImplemented("prepareBundle") as never,
      renderFilesWithHandle: () => notImplemented("renderFilesWithHandle") as never,
      releaseBundle: () => Effect.void,
      isReady: Effect.succeed(true),
    }
    return Layer.provide(
      WasmBoilerplateLive,
      Layer.mergeAll(
        makeTestFileSystem(),
        makeTestSpawner(),
        Layer.succeed(WasmRuntime, wasm),
      ),
    )
  }

  const templateError = new WasmError({
    message: 'template: template:1:22: executing "template" at <.Names>: map has no entry for key "Names"',
    kind: "internal",
  })

  function run<A>(
    layer: Layer.Layer<BoilerplateRenderer>,
    f: (r: BoilerplateRendererShape) => Effect.Effect<A, RenderError>,
  ) {
    return Effect.runPromise(
      Effect.either(Effect.flatMap(BoilerplateRenderer, f)).pipe(Effect.provide(layer)),
    )
  }

  it("renderFileStrict fails with RenderError on a template error", async () => {
    const layer = rendererOver(() => Effect.fail(templateError))
    const result = await run(layer, (r) => r.renderFileStrict("docker ps --format '{{.Names}}'", {}))
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(RenderError)
      expect(result.left.message).toBe(templateError.message)
      expect(result.left.cause).toBe(templateError)
    }
  })

  it("renderFile still renders a template error as an inline marker for previews", async () => {
    const layer = rendererOver(() => Effect.fail(templateError))
    const result = await run(layer, (r) => r.renderFile("docker ps --format '{{.Names}}'", {}))
    expect(result).toEqual(Either.right(`[template error: ${templateError.message}]`))
  })

  it("both fail with RenderError when the WASM runtime cannot load", async () => {
    const layer = rendererOver(() =>
      Effect.fail(new WasmError({ message: "BOILERPLATE_WASM_DIR is not set", kind: "load" })),
    )
    for (const method of ["renderFile", "renderFileStrict"] as const) {
      const result = await run(layer, (r) => r[method]("{{ .inputs.X }}", {}))
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(RenderError)
    }
  })

  it("renderFileStrict passes the variables through as JSON unchanged", async () => {
    let seenVars = ""
    const layer = rendererOver((_template, varsJSON) => {
      seenVars = varsJSON
      return Effect.succeed("rendered")
    })
    const vars = { inputs: { A: "it's here" }, outputs: { b: { K: "v" } } }
    const result = await run(layer, (r) => r.renderFileStrict("X", vars))
    expect(result).toEqual(Either.right("rendered"))
    expect(JSON.parse(seenVars)).toEqual(vars)
  })
})
