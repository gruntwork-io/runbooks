/**
 * Clean error messages for IPC handler rejections.
 *
 * Electron serializes a rejected `ipcMain.handle` listener with
 * `error.toString()`. Many handlers return `runtime.runPromise(...)`, which
 * rejects with an Effect FiberFailure whose toString() is
 * "(FiberFailure) Tag: msg" followed by Cause.pretty's stack frames, and the
 * renderer shows that verbatim inline in blocks. A Data.TaggedError without a
 * `message` field (FileReadError, FileNotFoundError, ...) only says
 * "An error has occurred".
 *
 * installIpcErrorNormalization() fixes this for every handler in one place:
 * each rejection is rethrown as a plain Error whose message is the real
 * failure detail, so Electron sends "Error: <detail>" and nothing else. The
 * preload then strips Electron's "Error invoking remote method" wrapper (see
 * electron/shared/ipc-error-message.ts).
 *
 * Only `import type` from electron, so this stays unit-testable without an
 * Electron runtime (same approach as open-runbook.ts).
 */
import { Cause, Option, Runtime } from "effect"
import type { IpcMain } from "electron"
import type { GitError } from "../../../src/errors/index.ts"

/** Fields a Data.TaggedError from src/errors may carry, all optional. */
interface TaggedFailure {
  readonly _tag: string
  readonly message?: unknown
  readonly path?: unknown
  readonly id?: unknown
  readonly status?: unknown
  readonly cause?: unknown
}

function isTagged(err: unknown): err is TaggedFailure {
  return typeof err === "object" && err !== null && typeof (err as { _tag?: unknown })._tag === "string"
}

/**
 * Human-readable detail for a typed Effect failure (or any thrown value).
 * Never returns an empty string.
 */
export function describeFailure(err: unknown): string {
  if (isTagged(err)) {
    if (err._tag === "GitError") {
      const g = err as unknown as GitError
      // g.command already includes the "git " prefix (see GitCliClient.runGit).
      return g.stderr || `${g.command} failed (exit ${g.exitCode})`
    }
    if (typeof err.message === "string" && err.message !== "") return err.message
    // Data.TaggedError leaves the inherited Error.message empty unless the
    // error declares a `message` field, so build one from what it does carry,
    // e.g. "FileReadError (/x/y.txt): ENOENT: no such file or directory",
    // "ExecutableNotFoundError (id: build)" or "GitHubApiError (status 404)".
    const details = [
      typeof err.path === "string" ? err.path : "",
      typeof err.id === "string" ? `id: ${err.id}` : "",
      typeof err.status === "number" ? `status ${err.status}` : "",
    ].filter(Boolean)
    const where = details.length > 0 ? ` (${details.join(", ")})` : ""
    const why = err.cause instanceof Error && err.cause.message ? `: ${err.cause.message}` : ""
    return `${err._tag}${where}${why}`
  }
  const message = err instanceof Error ? err.message : String(err)
  return message || "An unknown error occurred"
}

/**
 * Convert a handler rejection into a plain Error that serializes cleanly
 * across IPC. The original is kept as `cause`, so Electron's own
 * "Error occurred in handler for '<channel>'" log in MAIN still shows the full
 * FiberFailure; only `toString()` crosses to the renderer, and it ignores
 * `cause`.
 */
export function toIpcError(err: unknown): Error {
  if (Runtime.isFiberFailure(err)) {
    const cause = err[Runtime.FiberFailureCauseId]
    const failure = Cause.failureOption(cause)
    if (Option.isSome(failure)) return new Error(describeFailure(failure.value), { cause: err })
    if (Cause.isInterruptedOnly(cause)) return new Error("The operation was interrupted", { cause: err })
    // A die: FiberFailure.message is the defect's head message, with no stack.
    // Never Cause.pretty, which is what toString() would send.
    return new Error(err.message, { cause: err })
  }
  return new Error(describeFailure(err), { cause: err })
}

/**
 * Wrap `ipc.handle` so every handler registered through it afterwards rethrows
 * failures via toIpcError(). Handlers keep calling `ipcMain.handle` directly
 * and can let `runtime.runPromise(...)` reject; errors a handler has already
 * turned into a clean Error (git.ts's runAndUnwrap, runbook.ts's
 * describeRunbookOpenError) pass through unchanged.
 *
 * Must run before the first `ipcMain.handle` call: main/index.ts installs it
 * ahead of its native handlers and registerAllIpcHandlers().
 */
export function installIpcErrorNormalization(ipc: Pick<IpcMain, "handle">): void {
  const register = ipc.handle.bind(ipc)
  ipc.handle = (channel, listener) =>
    register(channel, async (event, ...args) => {
      try {
        return await listener(event, ...args)
      } catch (err) {
        throw toIpcError(err)
      }
    })
}
