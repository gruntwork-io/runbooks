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

// GitHub
export class GitHubApiError extends Data.TaggedError("GitHubApiError")<{
  readonly status: number
  readonly message: string
}> {}

// Git
export class GitError extends Data.TaggedError("GitError")<{
  readonly command: string
  readonly stderr: string
  readonly exitCode: number
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
export class ExecError extends Data.TaggedError("ExecError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class ExecTimeoutError extends Data.TaggedError("ExecTimeoutError")<{
  readonly timeoutMs: number
}> {}

// Registry
export class RegistryError extends Data.TaggedError("RegistryError")<{
  readonly message: string
}> {}

export class ExecutableNotFoundError extends Data.TaggedError("ExecutableNotFoundError")<{
  readonly id: string
}> {}

// Remote source
export class RemoteSourceError extends Data.TaggedError("RemoteSourceError")<{
  readonly url: string
  readonly message: string
}> {}
