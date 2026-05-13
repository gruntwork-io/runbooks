/**
 * The warm-render dispatcher orchestrates the bundle producer + WASM runtime
 * to render a template entirely in-process. Output is a {path → content} map
 * plus a list of paths the caller must re-render via the cold subprocess.
 *
 * The dispatcher does NOT touch the filesystem. It returns rendered content
 * in memory; the IPC handler decides where to write (worktree, generated
 * files dir) and runs the manifest/diff pipeline on top.
 */
import { Context, Effect } from "effect"
import type {
  RenderError,
  WarmDisabledReason,
  WasmError,
  WasmPerFileErrorKind,
} from "../errors/index.ts"

export interface WarmFile {
  readonly path: string
  readonly content: string
}

export interface WarmPerFileError {
  readonly path: string
  readonly kind: WasmPerFileErrorKind
  readonly message: string
}

/**
 * Result of a warm-render attempt. The dispatcher may return:
 *   - A complete set of files (every requested path rendered warm)
 *   - A partial set, with the remainder listed in `coldNeeded` for the
 *     caller to fall back via subprocess
 *   - A `warmDisabled` flag set when the bundle is structurally
 *     incompatible (no analyzed output paths) or WASM isn't ready
 */
export interface WarmRenderResult {
  /** Files rendered successfully by the WASM bridge. */
  readonly files: ReadonlyArray<WarmFile>
  /**
   * Paths that the WASM bridge couldn't render with kinds that route to
   * cold (output_not_produced, dependency_not_in_bundle, dynamic_filename).
   * Caller renders these via the cold subprocess.
   */
  readonly coldNeeded: ReadonlyArray<string>
  /**
   * Files explicitly excluded by skip_files. Caller should treat as
   * deletions in the manifest diff.
   */
  readonly skipped: ReadonlyArray<string>
  /**
   * Per-file errors that don't route to cold — template-execution
   * failures the user should see. Caller surfaces these inline.
   */
  readonly renderErrors: ReadonlyArray<WarmPerFileError>
  /**
   * Set when the bundle isn't warm-eligible (analyzer found zero output
   * paths) or when the WASM runtime isn't loaded. The IPC handler should
   * skip warm entirely and run the legacy cold path.
   */
  readonly warmDisabled: boolean
  /** Reason warmDisabled is set, for debug logging only. */
  readonly disabledReason?: WarmDisabledReason
  /**
   * Every output path the analyzer knows this template produces. The IPC
   * handler uses this as the authoritative set of files for the manifest
   * — anything in the previous manifest that's missing from here is a
   * real orphan, not just a file we didn't bother re-rendering.
   */
  readonly allKnownPaths: ReadonlyArray<string>
  /**
   * The subset of `allKnownPaths` we actually asked WASM to render this
   * time — i.e. the dirty set computed from the variable diff. On the
   * very first render for a given templateId this equals `allKnownPaths`.
   * After the first render it's typically much smaller (just the files
   * whose declared inputs changed).
   */
  readonly attemptedPaths: ReadonlyArray<string>
  /**
   * True when the dirty-set computation produced zero paths — the user's
   * vars are identical to the previous render. The IPC handler can
   * short-circuit and reuse the previous manifest without touching disk.
   */
  readonly noChanges: boolean
}

export interface WarmRenderDispatcherShape {
  /**
   * Attempt to render the template warm. Returns a result describing what
   * the WASM path produced and what (if anything) still needs cold rendering.
   */
  readonly render: (
    templateId: string,
    templatePath: string,
    variables: Record<string, unknown>,
  ) => Effect.Effect<WarmRenderResult, RenderError | WasmError>

  /** Clear all cached bundles. */
  readonly reset: Effect.Effect<void>
}

export class WarmRenderDispatcher extends Context.Tag("WarmRenderDispatcher")<
  WarmRenderDispatcher,
  WarmRenderDispatcherShape
>() {}
