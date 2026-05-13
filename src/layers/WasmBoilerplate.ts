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
import { WasmRuntime } from "../services/WasmRuntime.ts"
import { RenderError } from "../errors/index.ts"

// ---------------------------------------------------------------------------
// Subprocess-backed renderTemplate
// ---------------------------------------------------------------------------

/**
 * Location of the `boilerplate` binary.
 *
 * Resolution order:
 *   1. `BOILERPLATE_BIN` env var (absolute path or bare command name)
 *   2. Bare `boilerplate` — relies on the user's PATH
 *
 * The binary is invoked in non-interactive mode with `--disable-dependency-prompt`,
 * so dependencies (remote templates) are pulled in without any stdin prompts.
 */
export function resolveBoilerplateBinary(): string {
  const env = process.env.BOILERPLATE_BIN
  if (env && env.length > 0) return env
  return "boilerplate"
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
    console.log("[boilerplate] var-file YAML (first 1200 chars):\n" + yamlText.slice(0, 1200))
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
 * Shell out to the boilerplate CLI to render a template tree.
 *
 * Streams stdout/stderr into buffers so that, on non-zero exit, the `stderr`
 * text can be surfaced through the resulting `RenderError` (makes
 * configuration mistakes in templates readable in the UI rather than a bare
 * "exit code 1").
 */
function runBoilerplate(
  templateDir: string,
  outputDir: string,
  varFilePath: string,
) {
  return Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const binary = resolveBoilerplateBinary()
    const args = [
      "--template-url", templateDir,
      "--output-folder", outputDir,
      "--var-file", varFilePath,
      "--non-interactive",
      "--disable-dependency-prompt",
    ]

    const tSpawn = Date.now()
    const proc = yield* spawner.spawn(binary, args).pipe(
      Effect.mapError(
        (err) =>
          new RenderError({
            message: `Failed to spawn boilerplate binary "${binary}". Ensure it is installed and on PATH, or set BOILERPLATE_BIN.`,
            cause: err,
          }),
      ),
    )
    const dSpawn = Date.now() - tSpawn

    // Wait for the subprocess to finish, but if our fiber is interrupted
    // (e.g. a newer render superseded this one), kill the subprocess so we
    // stop paying for CPU/network we no longer want. Without this, a stale
    // boilerplate CLI run would keep running in the background.
    return yield* Effect.gen(function* () {
      const tExec = Date.now()
      // Drain output (the spawner collects lines and emits them once the
      // process exits; stderr lines carry user-facing error detail).
      const lines = yield* Stream.runCollect(proc.output).pipe(
        Effect.catchAll(() =>
          Effect.succeed<Iterable<{ line: string; source: "stdout" | "stderr" }>>([]),
        ),
      )
      const stderrLines: string[] = []
      for (const l of lines) {
        if (l.source === "stderr") stderrLines.push(l.line)
      }

      const code = yield* proc.exitCode.pipe(
        Effect.catchAll(() => Effect.succeed(1)),
      )
      const dExec = Date.now() - tExec
      console.log("[boilerplate subprocess] timing(ms)", {
        binary,
        spawn: dSpawn,
        exec: dExec,
        exitCode: code,
      })
      if (code !== 0) {
        const stderrText = stderrLines.join("\n").trim()
        return yield* Effect.fail(
          new RenderError({
            message: stderrText.length > 0
              ? `boilerplate exited with code ${code}: ${stderrText}`
              : `boilerplate exited with code ${code}`,
          }),
        )
      }
    }).pipe(Effect.onInterrupt(() => proc.kill))
  })
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
