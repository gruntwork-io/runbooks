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

export function makeLogger(tag: string): Logger {
  const prefix = `[${tag}]`
  const debug = isDebugEnabled(tag)
    ? (...args: unknown[]) => console.debug(prefix, ...args)
    : noop
  return {
    debug,
    info: (...args: unknown[]) => console.log(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  }
}
