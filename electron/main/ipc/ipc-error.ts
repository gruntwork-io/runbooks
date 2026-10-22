/**
 * Clean error messages for IPC handler rejections.
 *
 * Electron serializes a rejected `ipcMain.handle` listener with
 * `error.toString()`. Many handlers return `runtime.runPromise(...)`, which
 * rejects with the error the program failed with, and the renderer shows its
 * toString() verbatim inline in blocks. A Data.TaggedError without a `message`
 * field (FileReadError, FileNotFoundError, ...) only says its tag.
 *
 * installIpcErrorNormalization() fixes this for every handler in one place:
 * each rejection is rethrown as a plain Error whose message is the real
 * failure detail, so Electron sends "Error: <detail>" and nothing else. The
 * preload then strips Electron's "Error invoking remote method" wrapper (see
 * electron/shared/ipc-error-message.ts).
 *
 * describeFailure() / describeCause() are also the one implementation for
 * error text that a handler returns or sends as an event rather than throws
 * (git.ts's { error } results and git:error events, remote.ts).
 *
 * Only `import type` from electron, so this stays unit-testable without an
 * Electron runtime (same approach as open-runbook.ts).
 */
import { Cause, Option } from "effect"
import type { IpcMain } from "electron"
import type { GitError } from "../../../src/errors/index.ts"
import { redactSecrets } from "../../../src/domain/vcs/redact.ts"

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
  return (
    typeof err === "object" && err !== null && typeof (err as { _tag?: unknown })._tag === "string"
  )
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
  return describeUntagged(err) || "An unknown error occurred"
}

/**
 * The text of a value that is not a tagged error: an Error's message, a
 * string `message` property (e.g. a rejection with { message }), a plain
 * object's JSON (e.g. Effect.die({ ... })) rather than "[object Object]", or
 * a primitive's String(). "" when there is nothing to show: null, undefined,
 * a function, or JSON.stringify failing on a circular value or a BigInt.
 */
function describeUntagged(err: unknown): string {
  if (err === null || err === undefined) return ""
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  if (
    typeof err === "number" ||
    typeof err === "boolean" ||
    typeof err === "bigint" ||
    typeof err === "symbol"
  ) {
    return String(err)
  }
  const { message } = err as { message?: unknown }
  if (typeof message === "string") return message
  try {
    return JSON.stringify(err) ?? ""
  } catch {
    return ""
  }
}

/**
 * User-facing text for a failed Exit's Cause: the typed failure when there is
 * one (describeFailure), a plain sentence for an interruption, and otherwise
 * the defect itself, described the same way. Never Cause.pretty, whose stack
 * frames belong in MAIN's log, not in the UI. Never returns an empty string.
 */
export function describeCause(cause: Cause.Cause<unknown>): string {
  const failure = Cause.findErrorOption(cause)
  if (Option.isSome(failure)) return describeFailure(failure.value)
  if (Cause.hasInterruptsOnly(cause)) return INTERRUPTED
  return describeFailure(Cause.squash(cause))
}

/**
 * Convert a handler rejection into a plain Error that serializes cleanly
 * across IPC. The original is kept as `cause`, so Electron's own
 * "Error occurred in handler for '<channel>'" log in MAIN still shows the full
 * error; only `toString()` crosses to the renderer, and it ignores `cause`.
 *
 * The message goes through redactSecrets() (src/domain/vcs/redact.ts) as
 * defense in depth: git stderr or a handler's own message could otherwise
 * carry a token to the renderer.
 */
export function toIpcError(err: unknown): Error {
  const message = isInterruptRejection(err) ? INTERRUPTED : describeFailure(err)
  return new Error(redactSecrets(message), { cause: err })
}

/** What the user reads when an operation was interrupted rather than failed. */
const INTERRUPTED = "The operation was interrupted"

/**
 * The message of the Error `runPromise` rejects with when the Cause holds
 * only interruptions. Effect does not export it; ipc-error.test.ts rejects
 * with a real interrupt, so a change of wording upstream fails there.
 */
const INTERRUPT_REJECTION_MESSAGE = "All fibers interrupted without error"

/**
 * Whether `err` is what `runPromise` rejects with for an interrupted program.
 * The Cause is gone by then, so the message is all there is to go on.
 */
function isInterruptRejection(err: unknown): boolean {
  return err instanceof Error && err.message === INTERRUPT_REJECTION_MESSAGE
}

/** The ipcMain objects installIpcErrorNormalization() has wrapped. */
const normalizedIpcs = new WeakSet<object>()

/**
 * Wrap `ipc.handle` so every handler registered through it afterwards rethrows
 * failures via toIpcError(). Handlers keep calling `ipcMain.handle` directly
 * and can let `runtime.runPromise(...)` reject. A plain Error a handler throws
 * keeps its message: git.ts's runAndUnwrap and remote.ts's valueOrUserError
 * build theirs with describeCause() too, and runbook.ts's
 * describeRunbookOpenError writes its own.
 *
 * Must run before the first `ipcMain.handle` call: ipc/index.ts installs it
 * when it is imported, ahead of main/index.ts's native handlers and
 * registerAllIpcHandlers(). Installing it again is a no-op.
 */
export function installIpcErrorNormalization(ipc: Pick<IpcMain, "handle">): void {
  if (normalizedIpcs.has(ipc)) return
  normalizedIpcs.add(ipc)
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
