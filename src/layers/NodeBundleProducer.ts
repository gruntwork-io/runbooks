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
import { Effect, Layer, Stream } from "effect"
import { BundleProducer } from "../services/BundleProducer.ts"
import type { BundleProducerShape, BundleArtifact } from "../services/BundleProducer.ts"
import type { InputsMapResult } from "../services/WasmRuntime.ts"
import { ProcessSpawner } from "../services/ProcessSpawner.ts"
import { RenderError } from "../errors/index.ts"
import { resolveBoilerplateBinary } from "./WasmBoilerplate.ts"

/**
 * In-memory cache. Module-scope so it's shared across all `get` invocations
 * within the main process. Cleared via `BundleProducer.clear`.
 */
const cache = new Map<string, BundleArtifact>()

export const NodeBundleProducerLive = Layer.effect(
  BundleProducer,
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner

    const impl: BundleProducerShape = {
      get: (templateId, templatePath) =>
        Effect.gen(function* () {
          const cached = cache.get(templateId)
          if (cached) return cached

          const t0 = Date.now()
          const binary = resolveBoilerplateBinary()
          const args = [
            "inputs",
            "map",
            "--template-url",
            templatePath,
            "--include-bundle",
          ]

          const proc = yield* spawner.spawn(binary, args).pipe(
            Effect.mapError(
              (err) =>
                new RenderError({
                  message: `Failed to spawn boilerplate binary "${binary}" for bundle producer. Ensure it is installed and on PATH, or set BOILERPLATE_BIN.`,
                  cause: err,
                }),
            ),
          )

          const lines = yield* Stream.runCollect(proc.output).pipe(
            Effect.catchAll(() =>
              Effect.succeed<Iterable<{ line: string; source: "stdout" | "stderr" }>>([]),
            ),
          )
          const stdoutBuf: string[] = []
          const stderrBuf: string[] = []
          for (const l of lines) {
            if (l.source === "stdout") stdoutBuf.push(l.line)
            else stderrBuf.push(l.line)
          }

          const exitCode = yield* proc.exitCode.pipe(Effect.catchAll(() => Effect.succeed(1)))
          if (exitCode !== 0) {
            return yield* Effect.fail(
              new RenderError({
                message:
                  stderrBuf.length > 0
                    ? `boilerplate inputs map exited ${exitCode}: ${stderrBuf.join("\n").trim()}`
                    : `boilerplate inputs map exited ${exitCode}`,
              }),
            )
          }

          const json = stdoutBuf.join("\n").trim()
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
            // CLI is likely an older version that pre-dates the flag.
            return yield* Effect.fail(
              new RenderError({
                message:
                  "boilerplate inputs map produced no `bundle` field. Confirm BOILERPLATE_BIN points at a binary built from feat/input-file-mapping or later.",
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
          cache.set(templateId, artifact)
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
        }),

      clear: Effect.sync(() => {
        cache.clear()
      }),

      invalidate: (templateId) =>
        Effect.sync(() => {
          cache.delete(templateId)
        }),
    }

    return impl
  }),
)
