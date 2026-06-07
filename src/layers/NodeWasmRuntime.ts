/**
 * Node-side live implementation of {@link WasmRuntime}.
 *
 * Loads the boilerplate-full WASM module from the directory pointed to by
 * BOILERPLATE_WASM_DIR. The directory must contain:
 *   - wasm_exec.js                (Go's WASM runtime glue, sets globalThis.Go)
 *   - boilerplate-full.wasm.br    (brotli-compressed full build, ~3.7 MB)
 *
 * Init is lazy by default — the first call to renderFiles pays
 * the ~600-900ms cold start. Call `eagerLoadInBackground()` after the app
 * window shows to amortize that against idle time before the user types.
 *
 * Concurrency: the boilerplate Go runtime is single-goroutine. We serialize
 * JS-side calls through a Promise chain so two simultaneous calls don't try
 * to re-enter the bridge. The dispatcher above us is already serial per
 * templateId, but a global serializer here is a cheap belt-and-suspenders.
 */
import { Effect, Layer } from "effect"
import { promises as fs } from "node:fs"
import path from "node:path"
import { brotliDecompress } from "node:zlib"
import { promisify } from "node:util"
import { WasmRuntime } from "../services/WasmRuntime.ts"
import type {
  WasmRuntimeShape,
  WasmRenderFilesResult,
} from "../services/WasmRuntime.ts"
import { WasmError } from "../errors/index.ts"

const decompress = promisify(brotliDecompress)

const BOILERPLATE_WASM_DIR_ENV = "BOILERPLATE_WASM_DIR"

/**
 * The JS-side type of the globals the WASM module exports. These are set on
 * globalThis by the Go runtime's main() after we call go.run(instance), and
 * remain valid for the lifetime of the runtime.
 */
interface BoilerplateExports {
  boilerplateRenderFiles(
    bundleJSON: string,
    pathsJSON: string,
    varsJSON: string,
  ): string | Error
  boilerplateInputsMap(bundleJSON: string, varsJSON: string): string | Error
  boilerplatePrepareBundle(bundleJSON: string): string | Error
  boilerplateRenderFilesWithHandle(
    handle: string,
    pathsJSON: string,
    varsJSON: string,
  ): string | Error
  boilerplateReleaseBundle(handle: string): void
  boilerplateRenderTemplate(templateStr: string, varsJSON: string): string | Error
}

// bun-types doesn't expose WebAssembly.Imports globally; define the shape here.
type WasmImports = Record<string, Record<string, Function | WebAssembly.Global | WebAssembly.Memory | WebAssembly.Table | number>>

/** The Go class set by wasm_exec.js as a side effect on import. */
interface GoCtor {
  new (): {
    importObject: WasmImports
    run(instance: WebAssembly.Instance): Promise<void>
  }
}

/**
 * Module-scope load state. A single shared promise so concurrent eager + lazy
 * triggers fold onto the same load.
 */
let loadPromise: Promise<BoilerplateExports> | null = null

async function loadWasm(): Promise<BoilerplateExports> {
  const wasmDir = process.env[BOILERPLATE_WASM_DIR_ENV]
  if (!wasmDir || wasmDir.length === 0) {
    throw new Error(
      `${BOILERPLATE_WASM_DIR_ENV} is not set; WASM renderer is disabled. ` +
        "Either set it to a directory containing boilerplate-full.wasm.br + wasm_exec.js, " +
        "or run with the subprocess renderer.",
    )
  }

  const wasmExecPath = path.join(wasmDir, "wasm_exec.js")
  const wasmPath = path.join(wasmDir, "boilerplate-full.wasm.br")

  // Importing wasm_exec.js sets globalThis.Go as a side effect.
  await import(wasmExecPath)

  const compressed = await fs.readFile(wasmPath)
  const wasmBytes = await decompress(compressed)

  const GoConstructor = (globalThis as { Go?: GoCtor }).Go
  if (!GoConstructor) {
    throw new Error(
      `wasm_exec.js at ${wasmExecPath} did not set globalThis.Go — wrong Go version or corrupted file?`,
    )
  }
  const go = new GoConstructor()
  const { instance } = await WebAssembly.instantiate(wasmBytes, go.importObject)

  // Don't await: Go's main() ends with `select {}` and blocks forever to keep
  // the runtime alive. Awaiting it would deadlock load. The unawaited promise
  // will only ever reject if the Go runtime panics — which we let bubble.
  void go.run(instance)

  // Yield a microtask so Go's main() has a chance to register the globals
  // before we read them. In practice they're set synchronously during run()
  // before the blocking select, but be defensive.
  await Promise.resolve()

  const g = globalThis as Partial<BoilerplateExports>
  if (
    typeof g.boilerplateRenderFiles !== "function" ||
    typeof g.boilerplateInputsMap !== "function" ||
    typeof g.boilerplatePrepareBundle !== "function" ||
    typeof g.boilerplateRenderFilesWithHandle !== "function" ||
    typeof g.boilerplateReleaseBundle !== "function" ||
    typeof g.boilerplateRenderTemplate !== "function"
  ) {
    throw new Error(
      "boilerplate WASM loaded but expected exports are not on globalThis. " +
        "This usually means a lite WASM build was loaded instead of the full build, " +
        "or the build is older than the prepared-bundle handler family.",
    )
  }

  return {
    boilerplateRenderFiles: g.boilerplateRenderFiles.bind(globalThis),
    boilerplateInputsMap: g.boilerplateInputsMap.bind(globalThis),
    boilerplatePrepareBundle: g.boilerplatePrepareBundle.bind(globalThis),
    boilerplateRenderFilesWithHandle: g.boilerplateRenderFilesWithHandle.bind(globalThis),
    boilerplateReleaseBundle: g.boilerplateReleaseBundle.bind(globalThis),
    boilerplateRenderTemplate: g.boilerplateRenderTemplate.bind(globalThis),
  }
}

/**
 * Internal: get the load promise, starting load on first call.
 */
function ensureLoading(): Promise<BoilerplateExports> {
  if (!loadPromise) {
    loadPromise = loadWasm().catch((err) => {
      // Reset on failure so a subsequent call can retry (e.g., after the
      // user sets BOILERPLATE_WASM_DIR). Without the reset, every future
      // call would receive the cached rejection.
      loadPromise = null
      throw err
    })
  }
  return loadPromise
}

/**
 * Kick off WASM load in the background without blocking. Safe to call
 * multiple times — folds onto the same load promise. Intended to be called
 * from the main process once the app window is shown, so the ~600-900ms
 * cold start overlaps with the user reading the runbook before typing.
 */
export function eagerLoadInBackground(): void {
  ensureLoading().catch((err) => {
    // Eager-load failures are non-fatal; the lazy path will retry. Logging
    // here so eager failures surface in main-process stdout where dev mode
    // can spot them.
    // eslint-disable-next-line no-console
    console.log("[WasmRuntime] eager load failed, will retry on first call:", err?.message ?? err)
  })
}

/** True if BOILERPLATE_WASM_DIR is set. Used by the dispatcher to skip the warm path entirely when WASM is disabled. */
export function isWasmConfigured(): boolean {
  const dir = process.env[BOILERPLATE_WASM_DIR_ENV]
  return typeof dir === "string" && dir.length > 0
}

/**
 * Promise chain serializer. The Go runtime serializes JS calls internally,
 * but explicit serialization here makes ordering and cancellation tractable
 * from the JS side.
 */
let serialChain: Promise<unknown> = Promise.resolve()
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = serialChain.then(work, work)
  // Don't propagate failure into the chain — one failed call shouldn't poison
  // every subsequent one. `.catch(noop)` on the chain itself, while
  // letting the caller see the original rejection on `next`.
  serialChain = next.catch(() => undefined)
  return next
}

/**
 * Detect a JS Error with the WASM bridge's `.kind` property. The bridge
 * attaches "structural" for whole-batch failures and one of the per-file
 * kinds otherwise; the structural ones are what we surface as WasmError.
 */
function isStructuralError(value: unknown): value is Error & { kind: string } {
  return (
    value instanceof Error &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    (value as unknown as { kind: string }).kind === "structural"
  )
}

/**
 * Invoke a bridge function through the shared load + serialize path, mapping
 * the three error shapes (structural, internal, load/init) to WasmError.
 * `onResult` converts the raw string to the desired return type.
 * `onInternalError` produces the WasmError for a non-structural Error return
 * (each method has a different message format or semantics).
 */
function callBridge<T>(
  invoke: (exports: BoilerplateExports) => string | Error,
  onResult: (out: string) => T,
  onInternalError: (out: Error) => WasmError,
): Effect.Effect<T, WasmError> {
  return Effect.tryPromise({
    try: async () => {
      const exports = await ensureLoading()
      const out = await serialize(async () => invoke(exports))
      if (isStructuralError(out)) {
        throw new WasmError({ message: out.message, kind: "structural", cause: out })
      }
      if (out instanceof Error) {
        throw onInternalError(out)
      }
      return onResult(out)
    },
    catch: (err) =>
      err instanceof WasmError
        ? err
        : new WasmError({
            message: err instanceof Error ? err.message : String(err),
            kind: "load",
            cause: err,
          }),
  })
}

export const NodeWasmRuntimeLive = Layer.effect(
  WasmRuntime,
  Effect.sync<WasmRuntimeShape>(() => ({
    renderFiles: (bundleJSON, paths, varsJSON) => {
      const pathsJSON = JSON.stringify(paths)
      return callBridge(
        (exp) => exp.boilerplateRenderFiles(bundleJSON, pathsJSON, varsJSON),
        (out) => JSON.parse(out) as WasmRenderFilesResult,
        (out) => new WasmError({
          message: `boilerplateRenderFiles returned Error without structural kind: ${out.message}`,
          kind: "internal",
          cause: out,
        }),
      )
    },

    prepareBundle: (bundleJSON) =>
      callBridge(
        (exp) => exp.boilerplatePrepareBundle(bundleJSON),
        (out) => out,
        (out) => new WasmError({
          message: `boilerplatePrepareBundle returned Error without structural kind: ${out.message}`,
          kind: "internal",
          cause: out,
        }),
      ),

    renderFilesWithHandle: (handle, paths, varsJSON) => {
      const pathsJSON = JSON.stringify(paths)
      return callBridge(
        (exp) => exp.boilerplateRenderFilesWithHandle(handle, pathsJSON, varsJSON),
        (out) => JSON.parse(out) as WasmRenderFilesResult,
        (out) => new WasmError({
          message: `boilerplateRenderFilesWithHandle returned Error without structural kind: ${out.message}`,
          kind: "internal",
          cause: out,
        }),
      )
    },

    releaseBundle: (handle) =>
      Effect.tryPromise({
        try: async () => {
          // Release is idempotent and `void`-returning. If the runtime
          // isn't loaded we silently skip — there's nothing to release.
          if (!isWasmConfigured()) return
          const exports = await ensureLoading().catch(() => null)
          if (!exports) return
          await serialize(async () => {
            exports.boilerplateReleaseBundle(handle)
          })
        },
        catch: () => undefined,
      }).pipe(Effect.ignore),

    renderTemplate: (templateStr, varsJSON) =>
      callBridge(
        (exp) => exp.boilerplateRenderTemplate(templateStr, varsJSON),
        (out) => out,
        // boilerplateRenderTemplate does not tag errors with "structural";
        // any Error here is a template-level failure (missing key, parse
        // error, etc.). Bare out.message (no method-name prefix).
        (out) => new WasmError({ message: out.message, kind: "internal", cause: out }),
      ),

    isReady: Effect.sync(() => {
      // The runtime is "ready" only after the load promise has resolved. We
      // check synchronously by inspecting whether globalThis has the expected
      // exports populated — the loader sets them only at the end of a
      // successful load, so this is a cheap, accurate readiness check.
      const g = globalThis as { boilerplateRenderFiles?: unknown }
      return typeof g.boilerplateRenderFiles === "function"
    }),
  })),
)
