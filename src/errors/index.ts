import { Data } from "effect"

// File system
export class FileNotFoundError extends Data.TaggedError("FileNotFoundError")<{
  readonly path: string
}> {}

export class FileReadError extends Data.TaggedError("FileReadError")<{
  readonly path: string
  readonly cause: unknown
}> {}

export class FileWriteError extends Data.TaggedError("FileWriteError")<{
  readonly path: string
  readonly cause: unknown
}> {}

export class FileWatchError extends Data.TaggedError("FileWatchError")<{
  readonly cause: unknown
}> {}

// Process
export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly command: string
  readonly cause: unknown
}> {}

// Path validation
export class PathTraversalError extends Data.TaggedError("PathTraversalError")<{
  readonly path: string
  readonly message: string
}> {}

export class PathValidationError extends Data.TaggedError("PathValidationError")<{
  readonly path: string
  readonly message: string
}> {}

// AWS
export class AwsAuthError extends Data.TaggedError("AwsAuthError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class AwsConfigError extends Data.TaggedError("AwsConfigError")<{
  readonly message: string
}> {}

export class AwsSsoError extends Data.TaggedError("AwsSsoError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Transport-failure classification for VCS API errors, set by
 * classifyTlsError (src/domain/tls/system-ca.ts). Present only
 * when the failure happened below HTTP (no response was received):
 *  - "tls": trust-store-fixable verification failure (custom/unknown CA)
 *  - "server-cert": the server's own certificate is bad (expired, or issued
 *    for a different hostname) — installing a CA cannot fix it
 *  - "network": DNS / connect / timeout
 * An HTTP 401/403 is an auth outcome and never carries a kind — this split is
 * what keeps a transport failure from ever rendering as invalid credentials.
 */
export type VcsTransportErrorKind = "tls" | "server-cert" | "network"

// GitHub
export class GitHubApiError extends Data.TaggedError("GitHubApiError")<{
  readonly status: number
  readonly message: string
  readonly kind?: VcsTransportErrorKind
}> {}

// GitLab
export class GitLabApiError extends Data.TaggedError("GitLabApiError")<{
  readonly status: number
  readonly message: string
  readonly kind?: VcsTransportErrorKind
}> {}

// Git
export class GitError extends Data.TaggedError("GitError")<{
  readonly command: string
  readonly stderr: string
  readonly exitCode: number
}> {}

/**
 * Failure of a provider-CLI interaction (the validation probe and other
 * gh/glab subprocess work). `stderr` must be sanitized (redacted) before it
 * crosses IPC or hits a log.
 */
export class VcsCliError extends Data.TaggedError("VcsCliError")<{
  readonly kind: "not-installed" | "not-authenticated" | "keyring-blocked" | "spawn" | "timeout" | "api"
  readonly stderr: string
}> {}

// Boilerplate
export class RenderError extends Data.TaggedError("RenderError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class BoilerplateConfigError extends Data.TaggedError("BoilerplateConfigError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Failure from the in-process WASM runtime. Distinct from RenderError so the
 * dispatcher can route on it: a WasmError generally means "the warm path is
 * unusable for this call" (loader failed, structural error, JSON unmarshal),
 * while RenderError still implies a template-level problem.
 */
export class WasmError extends Data.TaggedError("WasmError")<{
  readonly message: string
  /**
   * "structural" when the boilerplate WASM bridge returned an Error with
   * kind="structural" (bad bundle JSON, empty paths, etc.). "load" when
   * loading or instantiating the WASM module itself failed. "internal" for
   * unexpected JS-side problems.
   */
  readonly kind: "structural" | "load" | "internal"
  readonly cause?: unknown
}> {}

// Session
export class SessionError extends Data.TaggedError("SessionError")<{
  readonly message: string
}> {}

export class SessionNotFoundError extends Data.TaggedError("SessionNotFoundError")<{}> {}

// Execution
export class ExecTimeoutError extends Data.TaggedError("ExecTimeoutError")<{
  readonly timeoutMs: number
}> {}

// Registry
export class ExecutableNotFoundError extends Data.TaggedError("ExecutableNotFoundError")<{
  readonly id: string
}> {}

// Remote source
export class RemoteSourceError extends Data.TaggedError("RemoteSourceError")<{
  readonly url: string
  readonly message: string
}> {}

// ---------------------------------------------------------------------------
// Render vocabulary — shared between WasmRuntime, WarmRenderDispatcher, and
// the IPC handlers that orchestrate them.
// ---------------------------------------------------------------------------

/**
 * Per-file outcome when the WASM bridge processes one output path.
 * - `output_not_produced`, `dependency_not_in_bundle`, `dynamic_filename`
 *   route to the cold-render fallback (see ROUTE_TO_COLD_KINDS).
 * - `skip_files_excluded` means the file is deliberately omitted.
 * - `render` is a template bug worth surfacing to the user.
 */
export type WasmPerFileErrorKind =
  | "output_not_produced"
  | "dependency_not_in_bundle"
  | "dynamic_filename"
  | "skip_files_excluded"
  | "render"

/** Reason the warm path was disabled for a render. Debug-logging only. */
export type WarmDisabledReason =
  | "wasm-not-ready"
  | "no-output-paths-from-analyzer"
  | "warm-error-fallback"

/**
 * Per-file kinds that mean "WASM can't render this file but the subprocess
 * can." The dispatcher partitions on this set.
 *
 * `render` is deliberately NOT included: it indicates a template-execution
 * error that the cold subprocess would hit the same way (template-author
 * bug). We surface those to the user instead of paying the cold cost on
 * every render. If a WASM-specific bridge gap re-surfaces under this kind
 * (we previously hit `__each__` missing from dep-variable-default scopes),
 * re-add it here as a temporary workaround and file a boilerplate bug.
 */
export const ROUTE_TO_COLD_KINDS = new Set<WasmPerFileErrorKind>([
  "output_not_produced",
  "dependency_not_in_bundle",
  "dynamic_filename",
])
