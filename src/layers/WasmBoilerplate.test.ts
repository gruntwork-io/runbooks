import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { Effect, Either, Fiber, Layer } from "effect"
import { RenderError } from "../errors/index.ts"
import { BoilerplateRenderer } from "../services/BoilerplateRenderer.ts"
import { WasmRuntime, type WasmRuntimeShape } from "../services/WasmRuntime.ts"
import { makeTestFileSystem } from "../test-utils/TestFileSystem.ts"
import { makeControlledSpawner } from "../test-utils/TestSpawner.ts"
import { resolveBoilerplateBinary, WasmBoilerplateLive } from "./WasmBoilerplate.ts"

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

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// renderTemplate is the cold path: it writes a var file and shells out to
// the boilerplate CLI. WASM is never touched.
describe("WasmBoilerplateLive.renderTemplate", () => {
  let savedBin: string | undefined

  beforeEach(() => {
    savedBin = process.env.BOILERPLATE_BIN
    process.env.BOILERPLATE_BIN = "/app/resources/bin/boilerplate"
  })

  afterEach(() => {
    if (savedBin === undefined) {
      delete process.env.BOILERPLATE_BIN
    } else {
      process.env.BOILERPLATE_BIN = savedBin
    }
  })

  function makeRenderer(files: Record<string, string> = {}, opts: { deferSpawn?: boolean } = {}) {
    const spawner = makeControlledSpawner(opts)
    const layer = Layer.provide(
      WasmBoilerplateLive,
      Layer.mergeAll(
        makeTestFileSystem(files),
        spawner.layer,
        Layer.succeed(WasmRuntime, {} as WasmRuntimeShape),
      ),
    )
    const renderer = Effect.runSync(Effect.provide(BoilerplateRenderer, layer))
    return { spawner, renderer }
  }

  it("kills the boilerplate subprocess when a newer render supersedes it", async () => {
    const { spawner, renderer } = makeRenderer()

    const render = Effect.runFork(renderer.renderTemplate("/tpl", "/out", { Name: "a" }))
    await until(() => spawner.processes.length === 1)
    await Effect.runPromise(Fiber.interrupt(render))

    expect(spawner.processes[0].killed()).toBe(true)
  })

  it("kills the subprocess when the render is interrupted while the spawn is completing", async () => {
    const { spawner, renderer } = makeRenderer({}, { deferSpawn: true })

    // The child already exists, but `spawn` has not handed it back yet. The
    // interrupt must wait for it and then kill it, not abandon it.
    const render = Effect.runFork(renderer.renderTemplate("/tpl", "/out", { Name: "a" }))
    await until(() => spawner.processes.length === 1)
    const interrupted = Effect.runPromise(Fiber.interrupt(render))
    spawner.processes[0].completeSpawn()
    await interrupted

    expect(spawner.processes[0].killed()).toBe(true)
  })

  it("fails with the CLI's stderr when boilerplate exits non-zero", async () => {
    const { spawner, renderer } = makeRenderer()

    const render = Effect.runPromise(
      Effect.either(renderer.renderTemplate("/tpl", "/out", {})),
    )
    await until(() => spawner.processes.length === 1)
    spawner.processes[0].finish(1, [{ line: "missing required variable Name", source: "stderr" }])

    const result = await render
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.message).toBe(
        "boilerplate exited with code 1: missing required variable Name",
      )
    }
  })

  it("never logs variable values", async () => {
    const files: Record<string, string> = {}
    const { spawner, renderer } = makeRenderer(files)
    const log = spyOn(console, "log")
    try {
      const render = Effect.runPromise(
        renderer.renderTemplate("/tpl", "/out", { DbPassword: "hunter2-s3cret" }),
      )
      await until(() => spawner.processes.length === 1)

      // The value really does reach the CLI through the var file...
      const args = spawner.processes[0].args
      const varFile = args[args.indexOf("--var-file") + 1]
      expect(files[varFile]).toContain("hunter2-s3cret")

      spawner.processes[0].finish(0)
      await render

      // ...but never main-process stdout, where a sensitive input would leak.
      const logged = JSON.stringify(log.mock.calls)
      expect(logged).not.toContain("hunter2-s3cret")
    } finally {
      log.mockRestore()
    }
  })
})
