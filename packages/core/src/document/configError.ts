/**
 * What the parser reports about a runbook, each with the place to fix it.
 * Every client shows these at load, before anything runs. An error that
 * leaves nothing safe to show refuses the runbook; an error in one block
 * stops only that block.
 */
import { Schema } from "effect"

/** A 1-based place in a file. */
export const Position = Schema.Struct({
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  column: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type Position = typeof Position.Type

export const Span = Schema.Struct({ start: Position, end: Position })
export type Span = typeof Span.Type

/** Where a problem is: the file, the span, and the block and prop when there is one. */
export const Location = Schema.Struct({
  /** The runbook file, or the script or YAML file the problem is in. */
  file: Schema.String,
  span: Span,
  /** The block's tag and id as the author wrote them. */
  block: Schema.optionalKey(
    Schema.Struct({ tag: Schema.String, id: Schema.optionalKey(Schema.String) }),
  ),
  prop: Schema.optionalKey(Schema.String),
})
export type Location = typeof Location.Type

/**
 * The configuration errors that refuse the whole runbook, because there is
 * no document to show or showing it would be unsafe. Nothing opens.
 */
export const RunbookErrorCode = Schema.Literals([
  /** The MDX, or the front matter's YAML, does not parse. */
  "syntax",
  /**
   * MDX that would run code, load a document or restyle the app when the
   * runbook opens: an import or export, an expression that is not a literal, a
   * script, frame, meta, base, link or style element, a prop that injects
   * HTML, a `javascript:` URL.
   */
  "notAllowed",
  /** A tag no block or alias in the registry has. */
  "unknownBlock",
  /** The front matter's `runbooks:` range excludes this app's version. */
  "versionRequired",
  /**
   * Blocks, elements, quotes or lists nested inside one another past the
   * depth the parser allows. Nested deeper, the engine and the window run out
   * of stack showing the runbook, so the parser refuses it before either
   * walks it.
   */
  "tooDeep",
])
export type RunbookErrorCode = typeof RunbookErrorCode.Type

/**
 * The configuration errors in one block. The runbook opens: the block's node
 * carries them, its status is `Misconfigured`, and it never runs. The other
 * blocks run.
 */
export const BlockErrorCode = Schema.Literals([
  /**
   * A prop's value does not decode with the block's schema. Also what the
   * engine finds in a block when a session opens: a form it cannot read, a
   * form output naming a field the form does not have, props it cannot send.
   */
  "badProp",
  /** An alias locks the prop, so the author may not set it. */
  "lockedProp",
  /**
   * Children the block cannot read: fenced YAML that does not parse or does
   * not decode, or a block inside a block that shows no markdown, which
   * would never appear.
   */
  "badChildren",
  /** A block that needs an id has none. */
  "missingId",
  /** Two blocks normalize to the same id. */
  "duplicateId",
  /** A reference prop or template reference names no block in the runbook. */
  "missingReference",
  /** The referenced block does not provide the capability the prop needs. */
  "missingCapability",
  /** A template reads an output key the target block does not declare. */
  "undeclaredOutput",
  /** The references form a cycle. */
  "cycle",
  /** A file the block names is missing, or resolves outside the runbook's folder. */
  "badFile",
])
export type BlockErrorCode = typeof BlockErrorCode.Type

/** Every kind of configuration error. A closed set: a client may branch on it. */
export const ConfigErrorCode = Schema.Union([RunbookErrorCode, BlockErrorCode])
export type ConfigErrorCode = typeof ConfigErrorCode.Type

/** Whether an error refuses the whole runbook, rather than stopping one block. */
export const refusesRunbook = (code: ConfigErrorCode): code is RunbookErrorCode =>
  Schema.is(RunbookErrorCode)(code)

/**
 * File order for errors and warnings: the runbook's own first, then those in
 * each file its blocks name, by path.
 */
export const byPlace =
  (runbook: string) =>
  (a: { readonly location: Location }, b: { readonly location: Location }): number => {
    const [fa, fb] = [a.location.file, b.location.file]
    if (fa !== fb) return fa === runbook ? -1 : fb === runbook ? 1 : fa < fb ? -1 : 1
    return (
      a.location.span.start.line - b.location.span.start.line ||
      a.location.span.start.column - b.location.span.start.column
    )
  }

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  code: ConfigErrorCode,
  message: Schema.String,
  location: Location,
  /** What was expected, in the author's terms: "a block id", "one of: aws, gcp". */
  expected: Schema.optionalKey(Schema.String),
  /**
   * What kind of value was received: text, a number, a list, an object,
   * true, false or null. Never the value itself: a prop may hold a secret.
   */
  received: Schema.optionalKey(Schema.String),
  /** The likely fix: the nearest block id or prop name. */
  suggestion: Schema.optionalKey(Schema.String),
}) {}

/** Every kind of configuration warning. The runbook still loads and runs. */
export const ConfigWarningCode = Schema.Literals([
  /** A prop kept as an alias for one release or more: `awsAuthId` and its siblings, for `envFrom`. */
  "deprecatedProp",
  /** Two `envFrom` sources set the same variable. The later one wins. */
  "envConflict",
  /** A prop the block does not take. It is ignored, as today. */
  "unknownProp",
])
export type ConfigWarningCode = typeof ConfigWarningCode.Type

export class ConfigWarning extends Schema.TaggedClass<ConfigWarning>()("ConfigWarning", {
  code: ConfigWarningCode,
  message: Schema.String,
  location: Location,
  suggestion: Schema.optionalKey(Schema.String),
}) {}
