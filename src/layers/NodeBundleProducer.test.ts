import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Cause, Effect, Either, Exit, Fiber, Layer, TestClock, TestContext } from "effect"
import { BundleProducer } from "../services/BundleProducer.ts"
import type { OutputLine } from "../services/ProcessSpawner.ts"
import { makeControlledSpawner } from "../test-utils/TestSpawner.ts"
import { BUNDLE_BUILD_TIMEOUT, NodeBundleProducerLive } from "./NodeBundleProducer.ts"

const VPC = "/runbook/templates/vpc"
const DB = "/runbook/templates/db"

/** stdout of a successful `boilerplate inputs map --include-bundle`. */
function inputsMapOutput(templatePath: string): OutputLine[] {
  const result = {
    inputs: {},
    files: { "main.tf": [] },
    bundle: { rootPath: templatePath, files: {} },
  }
  return [{ line: JSON.stringify(result), source: "stdout" }]
}

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Give any fiber that is about to spawn a chance to do so. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

function makeProducer() {
  const spawner = makeControlledSpawner()
  const producer = Effect.runSync(
    Effect.provide(BundleProducer, Layer.provide(NodeBundleProducerLive, spawner.layer)),
  )
  return { spawner, producer }
}

describe("NodeBundleProducer", () => {
  let savedBin: string | undefined
  let ctx: ReturnType<typeof makeProducer>

  beforeEach(() => {
    savedBin = process.env.BOILERPLATE_BIN
    process.env.BOILERPLATE_BIN = "/app/resources/bin/boilerplate"
    ctx = makeProducer()
  })

  afterEach(async () => {
    // The cache and in-flight builds are module-scope, shared by every
    // producer instance: drop whatever this test left behind.
    await Effect.runPromise(ctx.producer.clear)
    if (savedBin === undefined) {
      delete process.env.BOILERPLATE_BIN
    } else {
      process.env.BOILERPLATE_BIN = savedBin
    }
  })

  it("keeps a build running when its caller is interrupted, and the next get joins it", async () => {
    const { spawner, producer } = ctx

    // boilerplate:render interrupts a render as soon as a newer keystroke
    // supersedes it. The bundle only depends on the template, so the newer
    // render must reuse the running build, not kill it and start over.
    const superseded = Effect.runFork(producer.get("vpc", VPC))
    await until(() => spawner.processes.length === 1)
    await Effect.runPromise(Fiber.interrupt(superseded))
    expect(spawner.kills()).toBe(0)

    const latest = Effect.runFork(producer.get("vpc", VPC))
    await settle()
    expect(spawner.processes).toHaveLength(1)

    spawner.processes[0].finish(0, inputsMapOutput(VPC))
    const artifact = await Effect.runPromise(Fiber.join(latest))
    expect(artifact.templatePath).toBe(VPC)

    // The finished build was cached.
    const again = await Effect.runPromise(producer.get("vpc", VPC))
    expect(again).toBe(artifact)
    expect(spawner.processes).toHaveLength(1)
    expect(spawner.kills()).toBe(0)
  })

  it("invalidate kills the running build, and its waiting caller sees an interrupt", async () => {
    const { spawner, producer } = ctx

    const waiting = Effect.runFork(producer.get("vpc", VPC))
    await until(() => spawner.processes.length === 1)

    await Effect.runPromise(producer.invalidate("vpc"))
    expect(spawner.processes[0].killed()).toBe(true)

    // Interrupt-only, so boilerplate:render reports the render as superseded
    // rather than as a failure.
    const exit = await Effect.runPromise(Fiber.await(waiting))
    expect(Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)).toBe(true)

    // The next get starts a fresh build from the new path.
    const next = Effect.runFork(producer.get("vpc", DB))
    await until(() => spawner.processes.length === 2)
    expect(spawner.processes[1].args).toContain(DB)
    spawner.processes[1].finish(0, inputsMapOutput(DB))
    const artifact = await Effect.runPromise(Fiber.join(next))
    expect(artifact.templatePath).toBe(DB)
  })

  it("clear kills every running build", async () => {
    const { spawner, producer } = ctx

    Effect.runFork(producer.get("vpc", VPC))
    Effect.runFork(producer.get("db", DB))
    await until(() => spawner.processes.length === 2)

    await Effect.runPromise(producer.clear)
    expect(spawner.processes.map((p) => p.killed())).toEqual([true, true])
  })

  it("kills a build that outlives the timeout, and the next get starts a fresh one", async () => {
    const { spawner, producer } = ctx

    // Every render of a template waits on the one shared build, so a build
    // that never finishes must not block the template for the rest of the
    // session. The waiting render gets a RenderError (so boilerplate:render
    // falls back to cold) and the hung subprocess is killed.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const hung = yield* Effect.fork(Effect.either(producer.get("vpc", VPC)))
        yield* Effect.promise(() => until(() => spawner.processes.length === 1))
        // Let the daemon's timeout register its sleep with the TestClock.
        yield* Effect.promise(settle)
        expect(spawner.kills()).toBe(0)

        yield* TestClock.adjust(BUNDLE_BUILD_TIMEOUT)
        return yield* Fiber.join(hung)
      }).pipe(Effect.provide(TestContext.TestContext)),
    )

    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.message).toBe("boilerplate inputs map timed out after 3m")
    }
    expect(spawner.processes[0].killed()).toBe(true)

    const retry = Effect.runFork(producer.get("vpc", VPC))
    await until(() => spawner.processes.length === 2)
    spawner.processes[1].finish(0, inputsMapOutput(VPC))
    const artifact = await Effect.runPromise(Fiber.join(retry))
    expect(artifact.templatePath).toBe(VPC)
  })

  it("does not cache a failed build, so the next get retries", async () => {
    const { spawner, producer } = ctx

    const failed = Effect.runPromise(Effect.either(producer.get("vpc", VPC)))
    await until(() => spawner.processes.length === 1)
    spawner.processes[0].finish(1, [{ line: "template not found", source: "stderr" }])
    const result = await failed
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left.message).toBe("boilerplate inputs map exited with code 1: template not found")
    }

    const retry = Effect.runFork(producer.get("vpc", VPC))
    await until(() => spawner.processes.length === 2)
    spawner.processes[1].finish(0, inputsMapOutput(VPC))
    const artifact = await Effect.runPromise(Fiber.join(retry))
    expect(artifact.templatePath).toBe(VPC)
  })
})
