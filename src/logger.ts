/**
 * Namespaced logger gated by the DEBUG environment variable.
 *
 * Usage:
 *   const log = makeLogger("ipc:exec")
 *   log.debug("handler called for:", id)   // only emitted if DEBUG matches
 *   log.info("eager loading WASM")          // always emitted
 *   log.warn("retrying after error")        // always emitted
 *   log.error("clone failed", err)          // always emitted
 *
 * DEBUG patterns (comma-separated):
 *   DEBUG=*                — enable everything
 *   DEBUG=ipc:*            — enable any tag starting with "ipc:"
 *   DEBUG=ipc:exec,git:*   — enable specific tag plus a prefix
 *   DEBUG=-ipc:exec        — disable a tag (with `*` or another prefix enabled)
 *
 * The patterns are evaluated once at module load, so changing process.env.DEBUG
 * at runtime has no effect. This matches the behaviour of the `debug` npm
 * package and keeps the per-call cost down to a boolean check.
 */

import { inspect } from "node:util"
import { Cause, Runtime } from "effect"
import { redactSecrets } from "./domain/vcs/redact.ts"

interface CompiledPattern {
  readonly negate: boolean
  readonly match: (tag: string) => boolean
}

/** Exposed for unit tests; production code should use `makeLogger`. */
export function compilePatterns(raw: string | undefined): CompiledPattern[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((pattern): CompiledPattern => {
      const negate = pattern.startsWith("-")
      const body = negate ? pattern.slice(1) : pattern
      if (body === "*") {
        return { negate, match: () => true }
      }
      if (body.endsWith(":*")) {
        const prefix = body.slice(0, -1) // keep the trailing ":"
        return { negate, match: (tag) => tag.startsWith(prefix) }
      }
      return { negate, match: (tag) => tag === body }
    })
}

const PATTERNS = compilePatterns(
  typeof process !== "undefined" ? process.env.DEBUG : undefined,
)

/** Exposed for unit tests. */
export function matchesPatterns(
  tag: string,
  patterns: CompiledPattern[],
): boolean {
  let enabled = false
  for (const pattern of patterns) {
    if (pattern.match(tag)) {
      enabled = !pattern.negate
    }
  }
  return enabled
}

function isDebugEnabled(tag: string): boolean {
  return matchesPatterns(tag, PATTERNS)
}

const noop = (..._args: unknown[]): void => {}

export interface Logger {
  readonly debug: (...args: unknown[]) => void
  readonly info: (...args: unknown[]) => void
  readonly warn: (...args: unknown[]) => void
  readonly error: (...args: unknown[]) => void
}

/** How many nested errors (cause links and FiberFailure unwraps) are printed. */
const MAX_ERROR_DEPTH = 4
/**
 * Redaction runs on the inspected text, so nothing may be cut before it:
 * util.inspect's default maxStringLength (10000) would end a long field such
 * as a clone's stderr mid-string, and a token cut in half matches neither the
 * exact-value nor the shape patterns.
 */
const INSPECT_OPTIONS = { depth: 4, maxStringLength: Infinity } as const
/** Own properties already covered by the stack line or the cause chain. */
const HEAD_KEYS = new Set(["name", "message", "stack", "cause"])

function formatUnknown(value: unknown, depth: number): string {
  return value instanceof Error ? formatError(value, depth) : inspect(value, INSPECT_OPTIONS)
}

/**
 * Render an Error as text for the redaction pass. The stack alone is not
 * enough: a Data.TaggedError keeps its payload (stderr, exitCode, status, ...)
 * in own fields and usually has an empty message, and a FiberFailure from
 * runPromise wraps the real error in a Cause. util.inspect can't be used on
 * the error itself: Effect's inspect hooks print only Cause.pretty for a
 * FiberFailure, and for every TaggedError under Bun. So unwrap FiberFailures,
 * then print the stack, the own fields and the cause chain explicitly.
 */
function formatError(err: Error, depth = 0): string {
  const canNest = depth < MAX_ERROR_DEPTH
  if (canNest && Runtime.isFiberFailure(err)) {
    const cause = err[Runtime.FiberFailureCauseId]
    const inner = [...Cause.failures(cause), ...Cause.defects(cause)]
    // An interruption-only cause has no error to show; Cause.pretty says so.
    if (inner.length === 0) return Cause.pretty(cause)
    return inner.map((e) => formatUnknown(e, depth + 1)).join("\n")
  }
  const head = err.stack ?? `${err.name}: ${err.message}`
  const fields = Object.fromEntries(Object.entries(err).filter(([key]) => !HEAD_KEYS.has(key)))
  const extra = Object.keys(fields).length > 0 ? ` ${inspect(fields, INSPECT_OPTIONS)}` : ""
  const cause =
    canNest && err.cause !== undefined ? `\n[cause] ${formatUnknown(err.cause, depth + 1)}` : ""
  return head + extra + cause
}

/**
 * Redaction pass: every string argument is scrubbed
 * of registered token values and token-shaped substrings before it reaches the
 * console. Error objects are formatted (stack, own fields such as a
 * TaggedError's stderr, and cause chain; FiberFailures are unwrapped first)
 * and the whole text goes through the same scrubber, so a token embedded in a
 * message or field (e.g. an authenticated clone URL) never hits a log.
 */
function sanitizeArgs(args: unknown[]): unknown[] {
  return args.map((arg) => {
    if (typeof arg === "string") return redactSecrets(arg)
    if (arg instanceof Error) return redactSecrets(formatError(arg))
    return arg
  })
}

export function makeLogger(tag: string): Logger {
  const prefix = `[${tag}]`
  const debug = isDebugEnabled(tag)
    ? (...args: unknown[]) => console.debug(prefix, ...sanitizeArgs(args))
    : noop
  return {
    debug,
    info: (...args: unknown[]) => console.log(prefix, ...sanitizeArgs(args)),
    warn: (...args: unknown[]) => console.warn(prefix, ...sanitizeArgs(args)),
    error: (...args: unknown[]) => console.error(prefix, ...sanitizeArgs(args)),
  }
}
