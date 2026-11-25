/**
 * What the parser reports about a runbook, each with the place to fix it.
 * Every client shows these at load, before anything runs.
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

/** Every kind of configuration error. A closed set: a client may branch on it. */
export const ConfigErrorCode = Schema.Literals([
  /** The MDX does not parse. */
  "syntax",
  /**
   * MDX that would run code or load a document when the runbook opens: an
   * import or export, an expression that is not a literal, a script or frame
   * element, a prop that injects HTML, a `javascript:` URL.
   */
  "notAllowed",
  /** A tag no block or alias in the registry has. */
  "unknownBlock",
  /** The front matter's `runbooks:` range excludes this app's version. */
  "versionRequired",
  /** A prop's value does not decode with the block's schema. */
  "badProp",
  /** An alias locks the prop, so the author may not set it. */
  "lockedProp",
  /** Fenced YAML children that do not parse or do not decode. */
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
export type ConfigErrorCode = typeof ConfigErrorCode.Type

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  code: ConfigErrorCode,
  message: Schema.String,
  location: Location,
  /** What was expected, in the author's terms: "a block id", "one of: aws, gcp". */
  expected: Schema.optionalKey(Schema.String),
  /** The value received. Never a value that could be a secret. */
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
