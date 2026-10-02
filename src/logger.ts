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

const PATTERNS = compilePatterns(typeof process !== "undefined" ? process.env.DEBUG : undefined)

/** Exposed for unit tests. */
export function matchesPatterns(tag: string, patterns: CompiledPattern[]): boolean {
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

/**
 * How many nested errors (cause links and FiberFailure unwraps) are printed.
 * Past it, a "[cause] ... (further causes not shown)" line ends the chain.
 */
const MAX_ERROR_DEPTH = 4
/**
 * The whole inspected text is redacted again, and for values redactDeep
 * doesn't rebuild (class instances, Maps) that is the only pass, so inspect
 * may not cut anything before it: its default maxStringLength (10000) would
 * end a long string mid-token, and a token cut in half matches neither the
 * exact-value nor the shape patterns.
 */
const INSPECT_OPTIONS = { depth: 4, maxStringLength: Infinity } as const
/**
 * Longest string redactDeep prints from an error field or a non-Error cause,
 * so a 5 MB clone stderr doesn't become a 5 MB log line. It is cut only after
 * it has been redacted, so a token straddling the cut is already gone.
 */
const MAX_STRING_LENGTH = 16 * 1024
/** Own properties already covered by the stack line or the cause chain. */
const HEAD_KEYS = new Set(["name", "message", "stack", "cause"])

function redactString(value: string): string {
  const redacted = redactSecrets(value)
  if (redacted.length <= MAX_STRING_LENGTH) return redacted
  const rest = redacted.length - MAX_STRING_LENGTH
  return `${redacted.slice(0, MAX_STRING_LENGTH)}...[${rest} more chars]`
}

/**
 * Redact (and cap) every string leaf before inspect prints it. inspect escapes
 * newlines, backslashes and quotes and splits a multi-line string into
 * '...\n' + '...' pieces, so a registered secret that spans lines (a Google
 * credential document, its PEM private key) would no longer match exactly
 * in the inspected text. Plain objects and arrays are rebuilt with redacted
 * leaves down to the depth inspect prints (deeper ones show as [Object]);
 * the copies map keeps a cycle a cycle. A copy keeps the objects below that
 * depth as they are, so it is reused only at the level it was made at or
 * deeper: reused higher up, inspect would print those objects unredacted.
 * An Error cause goes through formatError instead; an Error or other object
 * (class instance, Map) inside a field is printed as it is, and only the
 * whole-text pass sees it.
 */
function redactDeep(
  value: unknown,
  level = 0,
  copies = new WeakMap<object, { readonly copy: unknown; readonly level: number }>(),
): unknown {
  if (typeof value === "string") return redactString(value)
  if (typeof value !== "object" || value === null || level > INSPECT_OPTIONS.depth) return value
  const seen = copies.get(value)
  if (seen !== undefined && seen.level <= level) return seen.copy
  if (Array.isArray(value)) {
    const copy: unknown[] = []
    copies.set(value, { copy, level })
    // forEach skips holes, so a sparse array stays sparse.
    copy.length = value.length
    value.forEach((item, i) => {
      copy[i] = redactDeep(item, level + 1, copies)
    })
    return copy
  }
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const copy: Record<string, unknown> = proto === null ? Object.create(null) : {}
  copies.set(value, { copy, level })
  for (const [key, item] of Object.entries(value)) copy[key] = redactDeep(item, level + 1, copies)
  return copy
}

function formatUnknown(value: unknown, depth: number): string {
  return value instanceof Error
    ? formatError(value, depth)
    : inspect(redactDeep(value), INSPECT_OPTIONS)
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
  const hasCause = err.cause !== undefined
  // Effect's UnknownException also keeps its cause in an own `error` field;
  // the [cause] line prints it, so a field holding the same object as the
  // cause is skipped. A field that only equals a primitive cause is kept.
  const causeIsObject = typeof err.cause === "object" && err.cause !== null
  const fields = Object.fromEntries(
    Object.entries(err).filter(
      ([key, value]) => !HEAD_KEYS.has(key) && !(causeIsObject && value === err.cause),
    ),
  )
  const extra =
    Object.keys(fields).length > 0 ? ` ${inspect(redactDeep(fields), INSPECT_OPTIONS)}` : ""
  if (canNest) {
    return head + extra + (hasCause ? `\n[cause] ${formatUnknown(err.cause, depth + 1)}` : "")
  }
  // The depth limit stops here: say so rather than end the chain silently.
  const more = hasCause || Runtime.isFiberFailure(err)
  return head + extra + (more ? "\n[cause] ... (further causes not shown)" : "")
}

/**
 * Redaction pass: every string argument is scrubbed
 * of registered token values and token-shaped substrings before it reaches the
 * console. Error objects are formatted (stack, own fields such as a
 * TaggedError's stderr, and cause chain; FiberFailures are unwrapped first),
 * with every string in a field or non-Error cause scrubbed before inspect
 * escapes it, and the whole text then goes through the same scrubber, so a
 * token embedded in a message or field (e.g. an authenticated clone URL)
 * never hits a log.
 */
function sanitizeArgs(args: unknown[]): unknown[] {
  return args.map((arg) => {
    if (typeof arg === "string") return redactSecrets(arg)
    if (arg instanceof Error) {
      try {
        return redactSecrets(formatError(arg))
      } catch {
        // formatError reads every own enumerable property, so a throwing
        // getter would make the log call itself throw, often inside a catch
        // block, replacing the error being logged. Fall back to the stack.
        return redactSecrets(arg.stack ?? arg.message)
      }
    }
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
