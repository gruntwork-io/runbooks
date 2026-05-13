/**
 * Per-template bundle producer + cache.
 *
 * The WASM renderer can't reach the network, so we resolve a template's
 * dependency tree once via the boilerplate CLI (`inputs map --include-bundle`)
 * and hold the resulting JSON for the lifetime of the runbook session. Every
 * subsequent warm render reuses this in-memory bundle.
 *
 * Cache invalidation is per-session — the bundle is rebuilt only when a
 * different templateId is requested or when the cache is explicitly cleared
 * (e.g., user opens a different runbook). Edits to template files on disk
 * while the runbook is open will not be picked up; that's an acceptable
 * trade-off vs. the cost of running a watcher in production builds.
 */
import { Context, Effect } from "effect"
import type { WasmError, RenderError } from "../errors/index.ts"
import type { InputsMapResult } from "./WasmRuntime.ts"

/**
 * Cached bundle artifact. The full inputs-map result is preserved so the
 * dispatcher can use sources/files for warm-vs-cold classification and
 * dirty-set computation without re-running the analyzer.
 */
export interface BundleArtifact {
  /** Stable identity used as cache key — usually the Template component's id. */
  readonly templateId: string
  /** Absolute path passed to --template-url when the bundle was built. */
  readonly templatePath: string
  /** The full inputs-map JSON parsed once at bundle-producer time. */
  readonly inputsMap: InputsMapResult
  /** JSON-string form of the bundle field, ready to hand to WASM. */
  readonly bundleJSON: string
  /** Wall-clock ms when the bundle was produced. For debug logging only. */
  readonly producedAt: number
}

export interface BundleProducerShape {
  /**
   * Resolve a bundle for the given templateId. Returns the cached artifact
   * if one exists; otherwise shells out to the boilerplate CLI to build a
   * fresh one and caches it.
   */
  readonly get: (
    templateId: string,
    templatePath: string,
  ) => Effect.Effect<BundleArtifact, RenderError | WasmError>

  /**
   * Clear all cached bundles. Intended for "user opened a different runbook"
   * or "user invoked refresh" flows.
   */
  readonly clear: Effect.Effect<void>

  /** Remove a single template's cache entry. */
  readonly invalidate: (templateId: string) => Effect.Effect<void>
}

export class BundleProducer extends Context.Tag("BundleProducer")<
  BundleProducer,
  BundleProducerShape
>() {}
