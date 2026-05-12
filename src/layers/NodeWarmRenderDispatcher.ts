/**
 * Live WarmRenderDispatcher.
 *
 * Pipeline:
 *   1. BundleProducer.get(templateId, templatePath) — fetches (or builds + caches) the bundle JSON
 *   2. Look up the analyzer's full output set: keys of bundle.inputsMap.files
 *   3. Compute the *dirty* subset by diffing the current vars against the
 *      previous render's vars (kept in a per-templateId Map). On the very
 *      first render or when the `outputs` namespace changes, every output
 *      is considered dirty.
 *   4. If the dirty set is empty, short-circuit — the caller can reuse the
 *      previous manifest unchanged.
 *   5. Otherwise call WasmRuntime.renderFiles with ONLY the dirty paths so
 *      the WASM call's per-file work scales with the change, not the whole
 *      tree.
 *   6. Partition results: success / skip-files / route-to-cold / render-error.
 *
 * This layer does not own the cold-fallback subprocess invocation; the IPC
 * handler runs cold when `coldNeeded` is non-empty or when warm is disabled.
 * Keeping the dispatcher pure (no file I/O, no subprocess) makes it easy to
 * test and lets the handler stay in charge of where output ends up.
 */
import { Effect, Layer } from "effect"
import {
  WarmRenderDispatcher,
  type WarmRenderDispatcherShape,
  type WarmFile,
  type WarmPerFileError,
} from "../services/WarmRenderDispatcher.ts"
import { BundleProducer } from "../services/BundleProducer.ts"
import { WasmRuntime } from "../services/WasmRuntime.ts"
import type {
  WasmRenderResult,
  WasmRenderFilesResult,
  InputsMapResult,
} from "../services/WasmRuntime.ts"
import { ROUTE_TO_COLD_KINDS, WasmError } from "../errors/index.ts"

/**
 * Module-scope cache of "the variables we last successfully sent for this
 * templateId." Persists for the lifetime of the main process. Keyed by
 * templateId so independent templates don't pollute each other's diff.
 */
const previousVarsByTemplate = new Map<string, Record<string, unknown>>()

/**
 * Prepared-bundle handles keyed by templateId. The handle is an opaque
 * string returned by `boilerplatePrepareBundle`; we hold one per template
 * for the lifetime of the runbook session. Cleared on `reset()` and on
 * structural errors that suggest the handle went stale (WASM reload, etc.).
 */
const handlesByTemplate = new Map<string, string>()

/**
 * Cheap "did this change?" for var values. For primitives we use strict
 * equality; for objects/arrays we JSON-compare. JSON.stringify is order-
 * dependent for objects, but our vars come from the same renderer-side
 * structure call after call, so key order is stable in practice. Good
 * enough for dirty-set computation; a false positive (extra dirty path)
 * is cheap, a false negative (missed dirty path) would be a correctness
 * bug — but for that to happen the value would have to be `===` between
 * runs, which means it didn't actually change.
 */
function varsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== "object" || typeof b !== "object") return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Diff two `vars` objects at the top level, excluding the `inputs` and
 * `outputs` namespaces (the latter is handled separately, the former is a
 * mirror of root-level keys after `flattenVariables`/`liftInputsToRoot`).
 * Returns the set of top-level variable names whose value changed.
 */
function changedRootNames(
  prev: Record<string, unknown>,
  curr: Record<string, unknown>,
): Set<string> {
  const changed = new Set<string>()
  const seen = new Set<string>()
  for (const [k, v] of Object.entries(curr)) {
    if (k === "inputs" || k === "outputs") continue
    seen.add(k)
    if (!(k in prev) || !varsEqual(prev[k], v)) changed.add(k)
  }
  for (const k of Object.keys(prev)) {
    if (k === "inputs" || k === "outputs") continue
    if (!seen.has(k)) changed.add(k)
  }
  return changed
}

/**
 * Compute the set of output paths that need re-rendering, given the
 * analyzer's inverse index and the var diff. Algorithm:
 *
 *   1. If prevVars is null (first render this session), return every known
 *      output path — we have to render the world once to seed the manifest.
 *   2. If the `outputs` namespace changed at all (deep compare), return
 *      every known output — the analyzer doesn't currently surface output
 *      dependencies, so we can't be more surgical.
 *   3. Otherwise, walk the changed root names and collect output paths
 *      whose `inputsMap.files[path]` contains an input key whose `name`
 *      equals any changed name.
 *
 * "all known paths" is `Object.keys(inputsMap.files)` — the analyzer's
 * authoritative set of outputs this template produces.
 */
function computeDirtyPaths(
  inputsMap: InputsMapResult,
  prevVars: Record<string, unknown> | undefined,
  currentVars: Record<string, unknown>,
  allKnownPaths: ReadonlyArray<string>,
): { paths: ReadonlyArray<string>; reason: "first-render" | "outputs-changed" | "vars-diff" | "no-change" } {
  if (!prevVars) {
    return { paths: allKnownPaths, reason: "first-render" }
  }

  if (!varsEqual(prevVars.outputs, currentVars.outputs)) {
    return { paths: allKnownPaths, reason: "outputs-changed" }
  }

  const changedNames = changedRootNames(prevVars, currentVars)
  if (changedNames.size === 0) {
    return { paths: [], reason: "no-change" }
  }

  // Build a Set of input keys whose declared name is in changedNames.
  // We pay one pass over inputsMap.inputs and then file lookups are O(deps-per-file).
  const dirtyInputKeys = new Set<string>()
  for (const [key, entry] of Object.entries(inputsMap.inputs ?? {})) {
    if (entry?.name && changedNames.has(entry.name)) {
      dirtyInputKeys.add(key)
    }
  }

  if (dirtyInputKeys.size === 0) {
    // A var changed at root but the analyzer doesn't believe any file
    // references it. This happens for vars that are passed through to
    // deps but not actually consumed by template bodies. Nothing to do.
    return { paths: [], reason: "no-change" }
  }

  const dirty = new Set<string>()
  for (const path of allKnownPaths) {
    const deps = inputsMap.files[path] ?? []
    for (const k of deps) {
      if (dirtyInputKeys.has(k)) {
        dirty.add(path)
        break
      }
    }
  }
  return { paths: [...dirty], reason: "vars-diff" }
}

export const NodeWarmRenderDispatcherLive = Layer.effect(
  WarmRenderDispatcher,
  Effect.gen(function* () {
    const bundles = yield* BundleProducer
    const wasm = yield* WasmRuntime

    const impl: WarmRenderDispatcherShape = {
      render: (templateId, templatePath, variables) =>
        Effect.gen(function* () {
          const ready = yield* wasm.isReady
          if (!ready) {
            return {
              files: [],
              coldNeeded: [],
              skipped: [],
              renderErrors: [],
              warmDisabled: true,
              disabledReason: "wasm-not-ready",
              allKnownPaths: [],
              attemptedPaths: [],
              noChanges: false,
            }
          }

          const bundle = yield* bundles.get(templateId, templatePath)
          const allKnownPaths = Object.keys(bundle.inputsMap.files ?? {})

          if (allKnownPaths.length === 0) {
            return {
              files: [],
              coldNeeded: [],
              skipped: [],
              renderErrors: [],
              warmDisabled: true,
              disabledReason: "no-output-paths-from-analyzer",
              allKnownPaths: [],
              attemptedPaths: [],
              noChanges: false,
            }
          }

          const prevVars = previousVarsByTemplate.get(templateId)
          const { paths: dirtyPaths, reason } = computeDirtyPaths(
            bundle.inputsMap,
            prevVars,
            variables,
            allKnownPaths,
          )

          // eslint-disable-next-line no-console
          console.log("[WarmRenderDispatcher] dirty-set", {
            templateId,
            reason,
            dirtyCount: dirtyPaths.length,
            knownCount: allKnownPaths.length,
          })

          if (dirtyPaths.length === 0) {
            // No work — caller reuses previous manifest. Still record
            // current vars so a subsequent meaningful diff is correct.
            previousVarsByTemplate.set(templateId, variables)
            return {
              files: [],
              coldNeeded: [],
              skipped: [],
              renderErrors: [],
              warmDisabled: false,
              allKnownPaths,
              attemptedPaths: [],
              noChanges: true,
            }
          }

          const varsJSON = JSON.stringify(variables)

          // Get or create a prepared-bundle handle for this template.
          // First render per templateId pays ~30-50ms to parse the
          // bundle once; subsequent renders skip parse entirely and
          // bottom out at per-file template work (~5ms × dirty count).
          let handle = handlesByTemplate.get(templateId)
          let preparedThisCall = false
          if (!handle) {
            const tPrep = Date.now()
            handle = yield* wasm.prepareBundle(bundle.bundleJSON).pipe(
              // If preparation fails (structural error / loader hiccup),
              // null the handle and fall through to the non-handle path.
              // We don't want a prepare failure to block all rendering.
              Effect.catchAll((err) =>
                Effect.sync(() => {
                  // eslint-disable-next-line no-console
                  console.log("[WarmRenderDispatcher] prepareBundle failed, will use non-handle path", {
                    templateId,
                    error: (err as { message?: string }).message ?? String(err),
                  })
                  return ""
                }),
              ),
            )
            const dPrep = Date.now() - tPrep
            if (handle) {
              handlesByTemplate.set(templateId, handle)
              preparedThisCall = true
              // eslint-disable-next-line no-console
              console.log("[WarmRenderDispatcher] prepared handle", {
                templateId,
                handle,
                prepareMs: dPrep,
              })
            }
          }

          const t0 = Date.now()

          // Helper: dispatch the render. Tries the handle path first
          // when we have a handle; falls back to the non-handle path
          // if the handle is rejected (stale, runtime reloaded, etc.).
          const dispatchRender = () =>
            Effect.gen(function* () {
              if (handle) {
                const handleResult = yield* wasm
                  .renderFilesWithHandle(handle, dirtyPaths, varsJSON)
                  .pipe(
                    Effect.catchAll((err) => {
                      // Structural error means the handle was rejected
                      // (released, never existed, runtime reload). Drop
                      // it from our map so the NEXT render reprepares;
                      // for THIS render, fall through to the non-handle
                      // path so the user gets a result.
                      if (err instanceof WasmError && err.kind === "structural") {
                        // eslint-disable-next-line no-console
                        console.log("[WarmRenderDispatcher] handle rejected, falling back to renderFiles", {
                          templateId,
                          handle,
                          message: err.message,
                        })
                        handlesByTemplate.delete(templateId)
                        handle = undefined
                        return Effect.succeed(null as WasmRenderFilesResult | null)
                      }
                      return Effect.fail(err)
                    }),
                  )
                if (handleResult) return handleResult
              }
              // No handle or handle was rejected — non-handle bulk render.
              return yield* wasm.renderFiles(bundle.bundleJSON, dirtyPaths, varsJSON)
            })

          const wasmResult = yield* dispatchRender()
          const wasmMs = Date.now() - t0

          const files: WarmFile[] = []
          const coldNeeded: string[] = []
          const skipped: string[] = []
          const renderErrors: WarmPerFileError[] = []

          for (const r of wasmResult.results as WasmRenderResult[]) {
            if (r.error) {
              if (r.error.kind === "skip_files_excluded") {
                skipped.push(r.path)
              } else if (ROUTE_TO_COLD_KINDS.has(r.error.kind)) {
                coldNeeded.push(r.path)
              } else {
                renderErrors.push({
                  path: r.path,
                  kind: r.error.kind,
                  message: r.error.message,
                })
              }
              continue
            }
            files.push({ path: r.path, content: r.content ?? "" })
          }

          // eslint-disable-next-line no-console
          console.log("[WarmRenderDispatcher] rendered", {
            templateId,
            wasmMs,
            attempted: dirtyPaths.length,
            files: files.length,
            coldNeeded: coldNeeded.length,
            skipped: skipped.length,
            renderErrors: renderErrors.length,
            // True when this call used the prepared-bundle handle path
            // (or freshly prepared on this same call). False means we
            // fell back to non-handle renderFiles — useful for spotting
            // handle rejections that warrant investigation.
            usedHandle: Boolean(handle),
            preparedThisCall,
          })

          // Commit the current vars only after a successful render — that
          // way a failed render leaves us with the prior baseline so the
          // next attempt still sees the right diff.
          previousVarsByTemplate.set(templateId, variables)

          return {
            files,
            coldNeeded,
            skipped,
            renderErrors,
            warmDisabled: false,
            allKnownPaths,
            attemptedPaths: dirtyPaths,
            noChanges: false,
          }
        }),

      reset: Effect.gen(function* () {
        // Release every live handle before dropping the map. Each
        // release call is best-effort (idempotent on the Go side); we
        // don't fail reset() if a release errors. The Go-side bundle
        // store will GC its references when the handles are gone.
        for (const handle of handlesByTemplate.values()) {
          yield* wasm.releaseBundle(handle)
        }
        handlesByTemplate.clear()
        previousVarsByTemplate.clear()
        yield* bundles.clear
      }),
    }

    return impl
  }),
)
