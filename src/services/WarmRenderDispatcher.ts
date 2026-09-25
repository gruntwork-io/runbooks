/**
 * The warm-render dispatcher orchestrates the bundle producer + WASM runtime
 * to render a template entirely in-process. Output is a {path → content} map
 * plus a list of paths the caller must re-render via the cold subprocess.
 *
 * The dispatcher does NOT touch the filesystem. It returns rendered content
 * in memory; the IPC handler decides where to write (worktree, generated
 * files dir) and runs the manifest/diff pipeline on top. Because only the
 * caller knows when that output is actually on disk, the caller also
 * advances the dispatcher's vars baseline via `commit`.
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
   * Only the paths whose inputs changed since the last `commit` are rendered.
   * If `templatePath` differs from the one this templateId last rendered
   * from, the cached bundle, handle and vars baseline are dropped first and
   * this is a first render.
   */
  readonly render: (
    templateId: string,
    templatePath: string,
    variables: Record<string, unknown>,
  ) => Effect.Effect<WarmRenderResult, RenderError | WasmError>

  /**
   * Record `variables` as the baseline the next `render` diffs against. Call
   * it only once every file for these vars is on disk and the manifest is
   * stored. A render that's superseded or fails before then must not commit,
   * so the next dirty set still includes the files it never wrote.
   */
  readonly commit: (
    templateId: string,
    variables: Record<string, unknown>,
  ) => Effect.Effect<void>

  /**
   * Drop all warm-render state: release every prepared handle, forget every
   * vars baseline and template path, and clear the bundle cache. Call when
   * the user opens a different runbook.
   */
  readonly reset: Effect.Effect<void>

  /**
   * Drop cached vars + handle for a single template. Use when the previous
   * render's output directory was wiped externally (e.g., a `GitClone` over
   * the worktree, `rm -rf`, `git reset --hard`), or when the output now goes
   * to a different directory (e.g., another active worktree). Without this,
   * the next render's dirty-set diff would only re-emit files whose vars
   * changed — leaving the rest of the tree missing from disk because the
   * dispatcher trusts that prior output is still where it was left.
   */
  readonly invalidate: (templateId: string) => Effect.Effect<void>
}

export class WarmRenderDispatcher extends Context.Tag("WarmRenderDispatcher")<
  WarmRenderDispatcher,
  WarmRenderDispatcherShape
>() {}
