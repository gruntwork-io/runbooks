/**
 * BoilerplateRenderer implementation.
 *
 * Two concerns live here:
 *
 *  - `renderFile`: in-process Go text/template rendering via the boilerplate
 *    WASM runtime's `boilerplateRenderTemplate` export. Backs
 *    `<TemplateInline>` for per-keystroke previews of inline template
 *    snippets. The WASM bridge is already warm in the main process, so each
 *    call is a cheap JS→Go bounce with no subprocess startup.
 *
 *  - `renderTemplate`: shells out to the `boilerplate` CLI. This covers the
 *    full boilerplate feature surface (dependencies, skip_files, hooks,
 *    partials, all built-in functions) for the cold-render path.
 *
 * The WASM render hard-codes `OnMissingKey=ExitWithError`. To preserve the
 * permissive UX the hand-rolled engine used to provide (a typo like
 * `{{ .typoo }}` renders as `""` rather than blanking the whole preview),
 * we catch `WasmError(kind="internal")` and surface a single-line error
 * marker as the rendered output. Structural / load failures still propagate.
 */
import path from "node:path"
import { Effect, Layer, Stream } from "effect"
import { BoilerplateRenderer } from "../services/BoilerplateRenderer.ts"
import type { BoilerplateRendererShape } from "../services/BoilerplateRenderer.ts"
import { FileSystem } from "../services/FileSystem.ts"
import { ProcessSpawner } from "../services/ProcessSpawner.ts"
import type { SpawnedProcess } from "../services/ProcessSpawner.ts"
import { WasmRuntime } from "../services/WasmRuntime.ts"
import { RenderError } from "../errors/index.ts"

// ---------------------------------------------------------------------------
// Subprocess-backed renderTemplate
// ---------------------------------------------------------------------------

/**
 * Location of the vendored `boilerplate` binary.
 *
 * The app ships its own copy of the CLI (`just fetch-boilerplate` →
 * resources/bin) and the main process points `BOILERPLATE_BIN` at it before
 * any render can run. There is deliberately no fallback to a `boilerplate`
 * on PATH: a user-installed copy could be any version, and the CLI must
 * match the vendored WASM build or render output silently diverges. An
 * unset env var is a wiring bug, so fail with the reason rather than guess.
 *
 * The binary is invoked in non-interactive mode with `--disable-dependency-prompt`,
 * so dependencies (remote templates) are pulled in without any stdin prompts.
 */
export function resolveBoilerplateBinary(): Effect.Effect<string, RenderError> {
  const bin = process.env.BOILERPLATE_BIN
  if (bin && bin.length > 0) return Effect.succeed(bin)
  return Effect.fail(
    new RenderError({
      message:
        "BOILERPLATE_BIN is not set. The main process must point it at the vendored boilerplate binary (resources/bin) before rendering.",
    }),
  )
}

/**
 * Write a YAML file containing the rendered variables for `--var-file`.
 *
 * Boilerplate accepts arbitrarily-nested YAML values, so we let the `yaml`
 * package handle all primitives + nested maps/arrays. The file is written to
 * a unique path under `os.tmpdir()` and is the caller's responsibility to rm.
 */
function writeVarFile(
  variables: Record<string, unknown>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem
    const YAML = yield* Effect.promise(() => import("yaml"))
    const yamlText = YAML.stringify(variables ?? {})
    const tmpDir = yield* fs.mkdtemp("boilerplate-vars-").pipe(
      Effect.mapError(
        (err) =>
          new RenderError({
            message: "Failed to create temp directory for variables file",
            cause: err,
          }),
      ),
    )
    const varFilePath = path.join(tmpDir, "vars.yml")
    yield* fs.writeFile(varFilePath, yamlText).pipe(
      Effect.mapError(
        (err) =>
          new RenderError({
            message: `Failed to write variables file: ${varFilePath}`,
            cause: err,
          }),
      ),
    )
    return { varFilePath, varFileDir: tmpDir }
  })
}

/**
 * Run the vendored boilerplate CLI with `args` and collect its output.
 *
 * Streams stdout/stderr into buffers so that, on non-zero exit, the `stderr`
 * text can be surfaced through the resulting `RenderError` (makes
 * configuration mistakes in templates readable in the UI rather than a bare
 * "exit code 1"). `label` names the command in that error and in the timing
 * log.
 *
 * Every boilerplate subprocess goes through here: the cold render below and
 * the bundle build in NodeBundleProducer.
 */
export function runBoilerplateCli(
  args: string[],
  label: string,
): Effect.Effect<{ stdout: string[]; stderr: string[] }, RenderError, ProcessSpawner> {
  return Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const binary = yield* resolveBoilerplateBinary()

    // Wait for the subprocess to finish and map its exit code.
    const awaitExit = (proc: SpawnedProcess, dSpawn: number) =>
      Effect.gen(function* () {
        const tExec = Date.now()
        // Drain output (the spawner collects lines and emits them once the
        // process exits; stderr lines carry user-facing error detail).
        const lines = yield* Stream.runCollect(proc.output).pipe(
          Effect.catchAll(() =>
            Effect.succeed<Iterable<{ line: string; source: "stdout" | "stderr" }>>([]),
          ),
        )
        const stdout: string[] = []
        const stderr: string[] = []
        for (const l of lines) {
          if (l.source === "stdout") stdout.push(l.line)
          else stderr.push(l.line)
        }

        const code = yield* proc.exitCode.pipe(
          Effect.catchAll(() => Effect.succeed(1)),
        )
        const dExec = Date.now() - tExec
        console.log("[boilerplate subprocess] timing(ms)", {
          command: label,
          binary,
          spawn: dSpawn,
          exec: dExec,
          exitCode: code,
        })
        if (code !== 0) {
          const stderrText = stderr.join("\n").trim()
          return yield* Effect.fail(
            new RenderError({
              message: stderrText.length > 0
                ? `${label} exited with code ${code}: ${stderrText}`
                : `${label} exited with code ${code}`,
            }),
          )
        }
        return { stdout, stderr }
      })

    // If our fiber is interrupted (e.g. a newer render superseded this one,
    // or the bundle producer dropped a build), kill the subprocess so we
    // stop paying for CPU/network we no longer want. Without this, a stale
    // boilerplate CLI run would keep running in the background.
    //
    // Spawning and installing that kill are one uninterruptible step: the
    // child exists once `spawn` resolves, so an interrupt landing during the
    // spawn, or before `onInterrupt` is in place, would leave it running.
    // Spawning only waits for the child's "spawn" event, so holding off an
    // interrupt that long costs nothing. The interrupt then reaches the
    // wait, which kills the child.
    const tSpawn = Date.now()
    return yield* Effect.uninterruptibleMask((restore) =>
      spawner.spawn(binary, args).pipe(
        Effect.mapError(
          (err) =>
            new RenderError({
              message: `Failed to spawn vendored boilerplate binary "${binary}". The bundled copy is missing or not executable; run \`just fetch-boilerplate\`.`,
              cause: err,
            }),
        ),
        Effect.flatMap((proc) =>
          restore(awaitExit(proc, Date.now() - tSpawn)).pipe(
            Effect.onInterrupt(() => proc.kill),
          ),
        ),
      ),
    )
  })
}

/**
 * Shell out to the boilerplate CLI to render a template tree.
 */
function runBoilerplate(
  templateDir: string,
  outputDir: string,
  varFilePath: string,
) {
  return runBoilerplateCli(
    [
      "--template-url", templateDir,
      "--output-folder", outputDir,
      "--var-file", varFilePath,
      "--non-interactive",
      "--disable-dependency-prompt",
    ],
    "boilerplate",
  )
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

/**
 * `renderFile` routes through the WASM `boilerplateRenderTemplate` export so
 * inline previews share the same template engine (and helper-function surface)
 * as the bundle-backed renders.
 *
 * `renderTemplate` shells out to the real `boilerplate` binary for full
 * feature parity (dependencies, skip_files, hooks, partials, etc).
 */
export const WasmBoilerplateLive = Layer.effect(
  BoilerplateRenderer,
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const spawner = yield* ProcessSpawner
    const wasm = yield* WasmRuntime

    const impl: BoilerplateRendererShape = {
      renderFile: (templateContent: string, variables: Record<string, unknown>) =>
        wasm
          .renderTemplate(templateContent, JSON.stringify(variables ?? {}))
          .pipe(
            // The WASM build hard-codes `OnMissingKey=ExitWithError`. Surface
            // missing-key / parse-time failures inline rather than blanking
            // the whole preview — matches the permissive UX the hand-rolled
            // engine used to provide for `<TemplateInline>`.
            Effect.catchTag("WasmError", (err) =>
              err.kind === "internal"
                ? Effect.succeed(`[template error: ${err.message}]`)
                : Effect.fail(
                    new RenderError({ message: err.message, cause: err }),
                  ),
            ),
          ),

      renderTemplate: (
        templateDir: string,
        outputDir: string,
        variables: Record<string, unknown>,
      ) =>
        Effect.gen(function* () {
          const tStart = Date.now()
          // Ensure output root exists so boilerplate doesn't trip on it.
          const tMkdir = Date.now()
          yield* fs.mkdir(outputDir, { recursive: true }).pipe(
            Effect.mapError(
              (err) =>
                new RenderError({
                  message: `Failed to create output directory: ${outputDir}`,
                  cause: err,
                }),
            ),
          )
          const dMkdir = Date.now() - tMkdir

          const tVarFile = Date.now()
          const { varFilePath, varFileDir } = yield* writeVarFile(variables)
          const dVarFile = Date.now() - tVarFile

          const tSub = Date.now()
          yield* runBoilerplate(templateDir, outputDir, varFilePath).pipe(
            // Best-effort cleanup — never let a cleanup failure mask a render error.
            Effect.ensuring(fs.rm(varFileDir, { recursive: true, force: true }).pipe(Effect.ignore)),
          )
          const dSub = Date.now() - tSub
          console.log("[boilerplate renderTemplate] timing(ms)", {
            templateDir,
            outputDir,
            mkdirOutput: dMkdir,
            varFile: dVarFile,
            subprocess: dSub,
            total: Date.now() - tStart,
          })
        }).pipe(
          Effect.provideService(FileSystem, fs),
          Effect.provideService(ProcessSpawner, spawner),
        ),
    }

    return impl
  }),
)
