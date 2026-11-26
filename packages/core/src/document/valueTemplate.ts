/**
 * Text whose `{{ }}` name values, as a block's `env` values are written:
 * `{{ .inputs.<name> }}` and `{{ .outputs.<block>.<key> }}`. It is the part
 * of Go's template language whose result needs no template engine: text,
 * references, template comments, string constants (`{{ "{{" }}`,
 * ``{{`{{.Names}}`}}``), and the `{{-` and `-}}` trims, which drop the white
 * space beside them. Any other action (`if`, a pipe, a function) is refused.
 */
import { Redacted, Result, Schema } from "effect"
import { BlockId, type BlockOutputs } from "@runbooks/blocks-core/contract"
import { type FieldValue, type FormValues, templateText } from "@runbooks/blocks-core/form"

/** What an action holds. */
export type ActionHolds =
  | { readonly _tag: "Comment" }
  /** A string constant: its text. */
  | { readonly _tag: "Constant"; readonly text: string }
  /** `.inputs.<name>`, or a map field's key: `.inputs.tags.env`. */
  | { readonly _tag: "Input"; readonly path: ReadonlyArray<string> }
  | { readonly _tag: "Output"; readonly block: BlockId; readonly key: string }
  /** Anything else: a condition, a pipe, a function, or text for another tool. */
  | { readonly _tag: "Other" }

/** One `{{ }}` action in a text. */
interface TemplateAction {
  readonly _tag: "Action"
  /** The index of its `{{`, and the index after its `}}`. */
  readonly start: number
  readonly end: number
  /** As written, from `{{` to `}}`. */
  readonly written: string
  readonly trimBefore: boolean
  readonly trimAfter: boolean
  readonly holds: ActionHolds
}

/** A `{{` with no `}}` after it. */
interface UnclosedAction {
  readonly _tag: "Unclosed"
  readonly start: number
}

/**
 * Each action in `text`, in order. A `}}` inside a string constant does not
 * close its action, as in Go. An unclosed `{{` is followed by the actions
 * after it, as text that is not a template would read.
 */
function* templateActions(text: string): Generator<TemplateAction | UnclosedAction> {
  let at = 0
  while (true) {
    const start = text.indexOf("{{", at)
    if (start < 0) return
    const trimBefore = text[start + 2] === "-" && isSpace(text[start + 3])
    const codeStart = start + (trimBefore ? 3 : 2)
    const close = actionEnd(text, codeStart)
    if (close < 0) {
      yield { _tag: "Unclosed", start }
      at = start + 2
      continue
    }
    const trimAfter = text[close - 1] === "-" && isSpace(text[close - 2])
    const code = text.slice(codeStart, trimAfter ? close - 1 : close).trim()
    at = close + 2
    yield {
      _tag: "Action",
      start,
      end: at,
      written: text.slice(start, at),
      trimBefore,
      trimAfter,
      holds: holdsOf(code),
    }
  }
}

/** A reference to a value, and the index of its `{{` in the template. */
export interface ValueReference {
  /** As written, for a message. */
  readonly written: string
  readonly at: number
  readonly source: Extract<ActionHolds, { readonly _tag: "Input" | "Output" }>
}

/** A template's text, in order, with each reference apart. */
export type TemplatePart =
  | { readonly _tag: "Text"; readonly text: string }
  | ({ readonly _tag: "Reference" } & ValueReference)

/** Why a template cannot be filled in, and the index in it where that starts. */
export interface TemplateProblem {
  readonly at: number
  readonly message: string
}

/**
 * The template as text and references, its trims applied and its comments
 * and constants made text. The first action Runbooks cannot fill in, or an
 * unclosed `{{`, is the problem.
 */
export function parseValueTemplate(
  template: string,
): Result.Result<ReadonlyArray<TemplatePart>, TemplateProblem> {
  const parts: TemplatePart[] = []
  let text = ""
  let at = 0
  for (const action of templateActions(template)) {
    if (action._tag === "Unclosed")
      return Result.fail({ at: action.start, message: "A `{{` is not closed with `}}`." })
    const before = template.slice(at, action.start)
    text += action.trimBefore ? before.replace(TRAILING_SPACE, "") : before
    at = action.end
    if (action.trimAfter) at += (LEADING_SPACE.exec(template.slice(at))?.[0] ?? "").length
    const { holds, written } = action
    switch (holds._tag) {
      case "Comment":
        break
      case "Constant":
        text += holds.text
        break
      case "Input":
      case "Output":
        if (text !== "") parts.push({ _tag: "Text", text })
        text = ""
        parts.push({ _tag: "Reference", written, at: action.start, source: holds })
        break
      case "Other":
        return Result.fail({
          at: action.start,
          message: `\`${written}\` is not a value Runbooks can insert. A \`{{ }}\` may name a value, \`{{ .inputs.<name> }}\` or \`{{ .outputs.<block>.<key> }}\`, and nothing else: no condition, pipe or function. To write \`{{\` as text, write \`{{ "{{" }}\`.`,
        })
    }
  }
  text += template.slice(at)
  if (text !== "") parts.push({ _tag: "Text", text })
  return Result.succeed(parts)
}

/** What a template's references read: the block's values and the outputs its templates name. */
export interface ValueSources {
  readonly values: FormValues
  readonly outputs: BlockOutputs
}

/** The value a reference names, as text, redacted. */
function valueOf(
  reference: ValueReference,
  sources: ValueSources,
): Result.Result<Redacted.Redacted<string>, TemplateProblem> {
  const { source, written, at } = reference
  if (source._tag === "Output") {
    const value = sources.outputs.get(source.block)?.get(source.key)
    return value === undefined
      ? Result.fail({
          at,
          message: `\`${written}\` names an output block ${source.block} has not given.`,
        })
      : Result.succeed(value)
  }
  const [name, ...keys] = source.path
  let value: FieldValue | undefined = Object.hasOwn(sources.values, name!)
    ? sources.values[name!]
    : undefined
  for (const key of keys) {
    value =
      value !== undefined && typeof value === "object" && !Array.isArray(value)
        ? Object.hasOwn(value, key)
          ? (value as { readonly [key: string]: FieldValue })[key]
          : undefined
        : undefined
  }
  return value === undefined
    ? Result.fail({
        at,
        message: `\`${written}\` names no field of the forms this block reads (its \`inputsId\` forms and its own).`,
      })
    : Result.succeed(Redacted.make(templateText(value)))
}

/** `template` with each reference replaced by its value, redacted. */
export function renderValueTemplate(
  template: string,
  sources: ValueSources,
): Result.Result<Redacted.Redacted<string>, TemplateProblem> {
  const parsed = parseValueTemplate(template)
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
  let text = ""
  for (const part of parsed.success) {
    if (part._tag === "Text") {
      text += part.text
      continue
    }
    const value = valueOf(part, sources)
    if (Result.isFailure(value)) return Result.fail(value.failure)
    text += Redacted.value(value.success)
  }
  return Result.succeed(Redacted.make(text))
}

const INPUT = /^\.inputs((?:\.[A-Za-z0-9_-]+)+)$/
const OUTPUT = /^\.outputs\.([A-Za-z0-9_-]+)\.(\w+)$/
const toBlockId = Schema.decodeSync(BlockId)
/** White space as Go's template trim markers trim it. */
const LEADING_SPACE = /^[ \t\r\n]+/
const TRAILING_SPACE = /[ \t\r\n]+$/
const isSpace = (char: string | undefined) =>
  char === " " || char === "\t" || char === "\r" || char === "\n"

/** The index of the `}}` that closes the action whose code starts at `start`, or -1. */
function actionEnd(text: string, start: number): number {
  let at = start
  while (at < text.length && isSpace(text[at])) at++
  if (text.startsWith("/*", at)) {
    const end = text.indexOf("*/", at + 2)
    return end < 0 ? -1 : text.indexOf("}}", end + 2)
  }
  while (at < text.length) {
    const char = text[at]
    if (char === "`" || char === '"' || char === "'") {
      at = constantEnd(text, at)
      if (at < 0) return -1
    } else if (text.startsWith("}}", at)) return at
    else at++
  }
  return -1
}

/** The index after the constant that starts with the quote at `start`, or -1. */
function constantEnd(text: string, start: number): number {
  const quote = text[start]
  let at = start + 1
  while (at < text.length) {
    const char = text[at]
    if (char === quote) return at + 1
    if (quote !== "`" && char === "\\") at++
    else if (quote !== "`" && char === "\n") return -1
    at++
  }
  return -1
}

/** What an action's code, its trims and spaces removed, holds. */
function holdsOf(code: string): ActionHolds {
  if (code.startsWith("/*")) return { _tag: "Comment" }
  if (/^`[^`]*`$/.test(code)) return { _tag: "Constant", text: code.slice(1, -1) }
  if (code.startsWith('"') && code.endsWith('"')) {
    try {
      const constant: unknown = JSON.parse(code)
      if (typeof constant === "string") return { _tag: "Constant", text: constant }
    } catch {
      // Not a constant JSON can read, such as one with a Go-only escape.
    }
  }
  const input = INPUT.exec(code)
  if (input) return { _tag: "Input", path: input[1]!.slice(1).split(".") }
  const output = OUTPUT.exec(code)
  if (output) return { _tag: "Output", block: toBlockId(output[1]!), key: output[2]! }
  return { _tag: "Other" }
}
