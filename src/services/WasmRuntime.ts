/**
 * In-process Go-WASM runtime that hosts the boilerplate WASM exports.
 *
 * Boilerplate's WASM build registers four globals on the Go side
 * (boilerplateRenderTemplate, boilerplateInputsMap, boilerplateRenderFile,
 * boilerplateRenderFiles). Loading the WASM is expensive (~600-900ms for the
 * full build on M-series); this service exists to keep one warm Go runtime
 * alive for the lifetime of the main process so every render after the first
 * is a cheap JS→Go call.
 *
 * The boilerplate runtime is single-goroutine: js.FuncOf callbacks serialize
 * through the Go scheduler, so concurrent JS calls don't fan out. We rely on
 * the dispatcher above this service to serialize per-templateId.
 */
import { Context, Effect } from "effect"
import type { WasmError } from "../errors/index.ts"

/** Per-file result inside a renderFiles response. */
export interface WasmRenderResult {
  readonly path: string
  /** Set on success. Empty string is a valid empty file. */
  readonly content?: string
  /** Set on failure. Mutually exclusive with content. */
  readonly error?: WasmPerFileError
}

/**
 * Per-file error kind. The first three route to the cold-render fallback;
 * "skip_files_excluded" means the file is deliberately omitted; "render" is
 * a template bug worth surfacing to the user.
 */
export type WasmPerFileErrorKind =
  | "output_not_produced"
  | "dependency_not_in_bundle"
  | "dynamic_filename"
  | "skip_files_excluded"
  | "render"

/** Per-file error inside a renderFiles response. */
export interface WasmPerFileError {
  readonly kind: WasmPerFileErrorKind
  readonly message: string
}

/** Top-level envelope returned by boilerplateRenderFiles. */
export interface WasmRenderFilesResult {
  readonly results: ReadonlyArray<WasmRenderResult>
}

/** One declared input as reported by the analyzer. */
export interface InputEntry {
  readonly name: string
  readonly declared_in?: string
  readonly type?: string
  readonly description?: string
  readonly files?: ReadonlyArray<string>
}

/**
 * Parsed shape of `boilerplate inputs map --include-bundle` / WASM
 * `boilerplateInputsMap` output. Only the fields we consume are typed; the
 * rest is preserved as unknown so the boilerplate team can extend the schema
 * without coordinated changes here.
 */
export interface InputsMapResult {
  /**
   * Forward index: input key → metadata. Keys are "<templatePath>:<inputName>".
   * The dirty-set dispatcher uses this to resolve the bare input name from
   * a key when iterating files[*].
   */
  readonly inputs: Record<string, InputEntry>
  /**
   * Inverse index: output path → list of input keys whose change re-renders
   * that file. Input keys are "<templatePath>:<inputName>".
   */
  readonly files: Record<string, string[]>
  /** Output path → source template path (relative to bundle root in FS mode). */
  readonly sources: Record<string, string>
  /** Soft errors from analysis. A non-empty list is not necessarily fatal. */
  readonly errors: ReadonlyArray<{ kind: string; message?: string; template?: string; file?: string }>
  /**
   * Present when `--include-bundle` was passed to the CLI. The dispatcher
   * needs this to feed back into the WASM render functions.
   */
  readonly bundle?: BundleSnapshot
}

/** Snapshot of every text file in the resolved dependency tree. */
export interface BundleSnapshot {
  readonly rootPath: string
  readonly files: Record<string, string>
  readonly dependencies: Record<string, ReadonlyArray<{ name: string; bundlePath: string; outputFolder?: string }>>
}

/**
 * Service surface. Methods accept already-JSON-encoded strings rather than
 * parsed objects because the WASM bridge does the parsing internally — we
 * would just be re-serializing.
 */
export interface WasmRuntimeShape {
  /**
   * Render N output paths from a bundle in one WASM call. The bundle JSON
   * is parsed once on the Go side; subsequent paths reuse the parsed state
   * within that single call only. Prefer `prepareBundle` +
   * `renderFilesWithHandle` for repeated renders against the same bundle.
   */
  readonly renderFiles: (
    bundleJSON: string,
    paths: ReadonlyArray<string>,
    varsJSON: string,
  ) => Effect.Effect<WasmRenderFilesResult, WasmError>

  /**
   * Parse a bundle once and stash it inside the Go runtime. Returns an
   * opaque handle ID the caller passes to `renderFilesWithHandle` for as
   * long as the bundle is valid (typically the lifetime of a runbook
   * session). Costs are paid up-front (~30-50ms on a 500KB bundle); every
   * subsequent render skips the bundle JSON parse + MapFS construction.
   */
  readonly prepareBundle: (
    bundleJSON: string,
  ) => Effect.Effect<string, WasmError>

  /**
   * Render N paths against a previously prepared bundle. Per-render cost
   * is just the actual template work plus a small JSON parse for paths/vars.
   * Structural error (kind="structural") indicates the handle was rejected
   * — typically because it was released, never existed, or the runtime
   * was reloaded. Caller should release+re-prepare and retry, or fall
   * back to the non-handle `renderFiles` path.
   */
  readonly renderFilesWithHandle: (
    handle: string,
    paths: ReadonlyArray<string>,
    varsJSON: string,
  ) => Effect.Effect<WasmRenderFilesResult, WasmError>

  /**
   * Release a handle. Idempotent — releasing an unknown handle is a no-op.
   * Callers don't need to track which handles they've already released.
   */
  readonly releaseBundle: (
    handle: string,
  ) => Effect.Effect<void>

  /**
   * Analyze a bundle and return the inputs/files/sources map. Used by the
   * dispatcher to compute the dirty set when a single variable changes.
   */
  readonly inputsMap: (
    bundleJSON: string,
    varsJSON: string,
  ) => Effect.Effect<InputsMapResult, WasmError>

  /**
   * Render a single Go text/template string with a vars map. No bundle, no
   * dependency tree — pure string-in / string-out using the boilerplate Go
   * template engine plus its helper functions (sprig-style). Backs the
   * inline-preview path (`<TemplateInline>`).
   *
   * The WASM build hard-codes `OnMissingKey=ExitWithError`, so an unresolved
   * `{{ .typo }}` surfaces as a `WasmError` with `kind="internal"`. Callers
   * that need a permissive UX should map that to a placeholder string.
   */
  readonly renderTemplate: (
    templateStr: string,
    varsJSON: string,
  ) => Effect.Effect<string, WasmError>

  /**
   * True when the runtime is loaded and ready. Lets callers decide between
   * the warm path (this returns true) and the cold subprocess fallback
   * (returns false because WASM is disabled, unloaded, or failed to init).
   */
  readonly isReady: Effect.Effect<boolean>
}

export class WasmRuntime extends Context.Tag("WasmRuntime")<
  WasmRuntime,
  WasmRuntimeShape
>() {}
