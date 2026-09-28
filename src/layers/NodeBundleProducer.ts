/**
 * Live BundleProducer implementation.
 *
 * Shells out to `boilerplate inputs map --include-bundle --template-url X`
 * to produce a self-contained bundle JSON that includes:
 *   - inputs / files / sources / errors (static-analysis map)
 *   - bundle.rootPath / bundle.files / bundle.dependencies (file contents)
 *
 * The bundle is what feeds boilerplateRenderFiles / boilerplateInputsMap on
 * the WASM side. We split this from WasmBoilerplateLive so the cold renderer
 * can keep working unchanged.
 */
import { Duration, Effect, Exit, Fiber, Layer } from "effect"
import { BundleProducer } from "../services/BundleProducer.ts"
import type { BundleProducerShape, BundleArtifact } from "../services/BundleProducer.ts"
import type { InputsMapResult } from "../services/WasmRuntime.ts"
import { ProcessSpawner } from "../services/ProcessSpawner.ts"
import { RenderError } from "../errors/index.ts"
import { runBoilerplateCli } from "./WasmBoilerplate.ts"

/**
 * In-memory cache. Module-scope so it's shared across all `get` invocations
 * within the main process. Cleared via `BundleProducer.clear`.
 */
const cache = new Map<string, BundleArtifact>()

/**
 * Builds still running, keyed by templateId. A build runs in its own daemon
 * fiber, not the caller's: boilerplate:render interrupts a render as soon as
 * a newer keystroke supersedes it, but the bundle depends only on the
 * template, so the newer render needs the very same build. An interrupted
 * caller just stops waiting and the next `get` joins the running
 * subprocess. A build is interrupted, which kills its subprocess, only by
 * `clear`/`invalidate` or by BUNDLE_BUILD_TIMEOUT.
 */
const inFlight = new Map<string, Fiber.RuntimeFiber<BundleArtifact, RenderError>>()

/**
 * Upper bound on one bundle build. Every render of a template waits on the
 * same shared build, so a build that never finishes (say, a remote
 * dependency fetch that hangs after a network change) would otherwise block
 * that template's warm path for the rest of the session: reopening the same
 * runbook does not reset it. On timeout the build is interrupted, which
 * kills the subprocess, and it fails. The failure drops it from `inFlight`,
 * so the waiting render falls back to cold and the next render starts a
 * fresh build. Generous, because a first fetch of remote dependencies can
 * legitimately take a while.
 */
export const BUNDLE_BUILD_TIMEOUT = Duration.minutes(3)

/**
 * Run `boilerplate inputs map --include-bundle` for one template and parse
 * its output into a BundleArtifact.
 */
function buildBundle(templateId: string, templatePath: string) {
  return Effect.gen(function* () {
    const t0 = Date.now()
    const { stdout } = yield* runBoilerplateCli(
      ["inputs", "map", "--template-url", templatePath, "--include-bundle"],
      "boilerplate inputs map",
    )

    const json = stdout.join("\n").trim()
    let parsed: InputsMapResult & { bundle?: unknown }
    try {
      parsed = JSON.parse(json) as InputsMapResult & { bundle?: unknown }
    } catch (err) {
      return yield* Effect.fail(
        new RenderError({
          message: "Failed to parse boilerplate inputs map JSON output",
          cause: err,
        }),
      )
    }

    if (!parsed.bundle || typeof parsed.bundle !== "object") {
      // --include-bundle is supposed to set this; if it's missing the
      // vendored CLI pre-dates the flag (boilerplate_version in the
      // justfile was rolled back too far).
      return yield* Effect.fail(
        new RenderError({
          message:
            "boilerplate inputs map produced no `bundle` field. The vendored boilerplate release is too old for `inputs map --include-bundle`; check boilerplate_version in the justfile.",
        }),
      )
    }

    // The bundle field on the CLI output is the same shape WASM
    // expects; just re-serialize the inner object so we have it as a
    // JSON string ready for boilerplateRenderFiles.
    const bundleJSON = JSON.stringify(parsed.bundle)

    const artifact: BundleArtifact = {
      templateId,
      templatePath,
      inputsMap: parsed,
      bundleJSON,
      producedAt: t0,
    }
    const elapsed = Date.now() - t0
    // eslint-disable-next-line no-console
    console.log("[BundleProducer] built", {
      templateId,
      templatePath,
      elapsedMs: elapsed,
      bundleFiles: Object.keys((parsed.bundle as { files?: Record<string, unknown> }).files ?? {}).length,
      outputs: Object.keys(parsed.files ?? {}).length,
    })
    return artifact
  })
}

export const NodeBundleProducerLive = Layer.effect(
  BundleProducer,
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner

    /**
     * Fork a build into a daemon fiber and register it in `inFlight`. The
     * fork and the registration run uninterruptibly, or an interrupt between
     * them would leave a build that nothing can join, cache or kill. The
     * build itself is made interruptible again so `clear`/`invalidate` and
     * the timeout can stop it.
     */
    const startBuild = (templateId: string, templatePath: string) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkDaemon(
            buildBundle(templateId, templatePath).pipe(
              Effect.timeoutFail({
                duration: BUNDLE_BUILD_TIMEOUT,
                onTimeout: () =>
                  new RenderError({
                    message: `boilerplate inputs map timed out after ${Duration.format(BUNDLE_BUILD_TIMEOUT)}`,
                  }),
              }),
              Effect.provideService(ProcessSpawner, spawner),
              Effect.interruptible,
            ),
          )
          inFlight.set(templateId, fiber)
          // Runs right away if the build has already finished. Only the
          // build still registered for this id may publish: `clear` and
          // `invalidate` unregister a build before interrupting it, and a
          // failed build drops out so the next `get` retries.
          fiber.addObserver((exit) => {
            if (inFlight.get(templateId) !== fiber) return
            inFlight.delete(templateId)
            if (Exit.isSuccess(exit)) cache.set(templateId, exit.value)
          })
          return fiber
        }),
      )

    const impl: BundleProducerShape = {
      get: (templateId, templatePath) =>
        Effect.gen(function* () {
          const cached = cache.get(templateId)
          if (cached) return cached

          const build = inFlight.get(templateId) ?? (yield* startBuild(templateId, templatePath))
          return yield* Fiber.join(build)
        }),

      clear: Effect.gen(function* () {
        const builds = [...inFlight.values()]
        inFlight.clear()
        cache.clear()
        yield* Fiber.interruptAll(builds)
      }),

      invalidate: (templateId) =>
        Effect.gen(function* () {
          const build = inFlight.get(templateId)
          inFlight.delete(templateId)
          cache.delete(templateId)
          if (build) yield* Fiber.interrupt(build)
        }),
    }

    return impl
  }),
)
