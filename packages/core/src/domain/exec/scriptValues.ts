/**
 * Values in a script's `{{ }}`: open decision 9, built as "keep `{{ }}` in
 * scripts and quote what it inserts".
 *
 * Each `{{ .inputs.<name> }}` and `{{ .outputs.<block>.<key> }}` becomes an
 * expansion of a variable that holds the value, quoted for where it stands
 * in the script:
 *
 * | Where | Inserted |
 * |---|---|
 * | Outside quotes, or in a comment | `"${RUNBOOK_VALUE_1}"` |
 * | In double quotes, or a heredoc whose delimiter is not quoted | `${RUNBOOK_VALUE_1}` |
 * | In single quotes | `'"${RUNBOOK_VALUE_1}"'`: the quotes close, then open again |
 *
 * So the value's text never enters the script, and bash never reads it as
 * code: it expands the variable once, and in quotes does not split or glob
 * what it holds. The run sets the variables with the rest of its environment.
 *
 * A reference is refused where bash would not expand the variable, or would
 * evaluate what it holds: in a heredoc whose delimiter is quoted, in `$'...'`,
 * in backquotes, in `${...}` and in arithmetic (`$((...))`, `((...))`); and
 * right after a `\` or a `$`, which would change what bash makes of it.
 * Bash still evaluates a value a script passes on to `eval`, `bash -c` or an
 * arithmetic test such as `[[ $x -eq 1 ]]`; nothing here can see that.
 *
 * Besides references, a script's `{{ }}` may hold a Go template comment, or a
 * string constant (``{{`{{.Names}}`}}``, `{{ "{{" }}`), whose text becomes
 * part of the script. `{{-` and `-}}` trim the white space beside them. Any
 * other action (`if`, a pipe, a function) is refused, and so is a reference
 * in a script that does not run with bash.
 */
import { Redacted, Result, Schema } from "effect"
import type { NonEmptyReadonlyArray } from "effect/Array"
import { BlockId, type BlockOutputs, type RunEnv } from "@runbooks/blocks-core/contract"
import { type FieldValue, type FormValues, templateText } from "@runbooks/blocks-core/form"

/** A script with each reference replaced, and the variables the replacements expand. */
export interface ScriptWithValues {
  readonly script: string
  /** `RUNBOOK_VALUE_<n>` for the script's nth distinct reference, from 1. */
  readonly env: RunEnv
}

/** Why a script's `{{ }}` cannot be inserted, where it stands in the script. */
export interface ScriptTemplateProblem {
  readonly line: number
  /** From 1, in UTF-16 code units, as a JavaScript string counts them. */
  readonly column: number
  readonly message: string
}

/** What the references read: the task's values and the outputs its templates name. */
export interface ValueSources {
  readonly values: FormValues
  readonly outputs: BlockOutputs
}

/**
 * `template` with each reference to a value replaced, for a script run with
 * `interpreter`, or every problem in it, in order. Each problem is refused:
 * none is left in the script.
 */
export function insertValues(
  template: string,
  sources: ValueSources,
  interpreter: string,
): Result.Result<ScriptWithValues, NonEmptyReadonlyArray<ScriptTemplateProblem>> {
  const found: Found[] = []
  for (let at = template.indexOf(MARK); at >= 0; at = template.indexOf(MARK, at + 1))
    found.push({ at, message: "The script holds a NUL character, which bash cannot run." })
  // A NUL marks a reference in the text, so one written in the template is read as a space.
  const { text, references } = splitTemplate(template.replaceAll(MARK, " "), found)

  const names = new Map<string, string>()
  const env: Record<string, Redacted.Redacted<string>> = {}
  const variables: string[] = []
  if (interpreter !== "bash")
    for (const { at, written } of references)
      found.push({
        at,
        message: `\`${written}\` names a value, and Runbooks inserts values only into a script that runs with bash or sh. This one runs with ${interpreter}.`,
      })
  else {
    for (const reference of references) {
      const value = valueOf(reference, sources)
      if (Result.isFailure(value)) found.push(value.failure)
      const known = names.get(reference.key)
      const name = known ?? `RUNBOOK_VALUE_${names.size + 1}`
      if (known === undefined) {
        names.set(reference.key, name)
        if (Result.isSuccess(value)) env[name] = value.success
      }
      variables.push(name)
    }
  }
  const script = interpreter === "bash" ? quoteAll(text, references, variables, found) : text

  const [first, ...rest] = found
    .sort((a, b) => a.at - b.at)
    .map(({ at, message }): ScriptTemplateProblem => ({ ...positionOf(template, at), message }))
  return first === undefined ? Result.succeed({ script, env }) : Result.fail([first, ...rest])
}

/** A problem, at its index in the template. */
interface Found {
  readonly at: number
  readonly message: string
}

/** The line and column of `index` in `text`, each from 1. */
function positionOf(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index)
  return { line: before.split("\n").length, column: index - before.lastIndexOf("\n") }
}

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

/** Where a reference stood in the template, the text left holds `MARK`. */
const MARK = "\u0000"

interface Reference {
  /** The action as written, for a message. */
  readonly written: string
  /** Where its `{{` is in the template. */
  readonly at: number
  /** One per value, so a value read twice is one variable. */
  readonly key: string
  readonly source:
    | { readonly _tag: "Input"; readonly path: ReadonlyArray<string> }
    | { readonly _tag: "Output"; readonly block: BlockId; readonly key: string }
}

const INPUT = /^\.inputs((?:\.[A-Za-z0-9_-]+)+)$/
const OUTPUT = /^\.outputs\.([A-Za-z0-9_-]+)\.(\w+)$/
const toBlockId = Schema.decodeSync(BlockId)
/** White space as Go's template trim markers trim it. */
const LEADING_SPACE = /^[ \t\r\n]+/
const TRAILING_SPACE = /[ \t\r\n]+$/
const isSpace = (char: string | undefined) =>
  char === " " || char === "\t" || char === "\r" || char === "\n"

/** The template's text with each reference a `MARK`, and the references in order. Adds each problem to `found`. */
function splitTemplate(
  template: string,
  found: Found[],
): { readonly text: string; readonly references: ReadonlyArray<Reference> } {
  let text = ""
  const references: Reference[] = []
  let at = 0
  while (at < template.length) {
    const open = template.indexOf("{{", at)
    if (open < 0) {
      text += template.slice(at)
      break
    }
    const trimBefore = template[open + 2] === "-" && isSpace(template[open + 3])
    const before = template.slice(at, open)
    text += trimBefore ? before.replace(TRAILING_SPACE, "") : before
    const start = open + (trimBefore ? 3 : 2)
    const close = actionEnd(template, start)
    if (close < 0) {
      found.push({ at: open, message: "A `{{` is not closed with `}}`." })
      break
    }
    const trimAfter = template[close - 1] === "-" && isSpace(template[close - 2])
    const body = template.slice(start, trimAfter ? close - 1 : close).trim()
    const written = template.slice(open, close + 2)
    at = close + 2
    if (trimAfter) at += (LEADING_SPACE.exec(template.slice(at))?.[0] ?? "").length

    const action = actionOf(body, written, open)
    if (Result.isFailure(action)) found.push(action.failure)
    else if (typeof action.success === "string") text += action.success
    else {
      references.push(action.success)
      text += MARK
    }
  }
  return { text, references }
}

/** The index of the `}}` that closes the action whose code starts at `start`, or -1. */
function actionEnd(template: string, start: number): number {
  let at = start
  while (at < template.length && isSpace(template[at])) at++
  if (template.startsWith("/*", at)) {
    const end = template.indexOf("*/", at + 2)
    return end < 0 ? -1 : template.indexOf("}}", end + 2)
  }
  while (at < template.length) {
    const char = template[at]
    if (char === "`" || char === '"' || char === "'") {
      at = constantEnd(template, at)
      if (at < 0) return -1
    } else if (template.startsWith("}}", at)) return at
    else at++
  }
  return -1
}

/** The index after the constant that starts with the quote at `start`, or -1. */
function constantEnd(template: string, start: number): number {
  const quote = template[start]
  let at = start + 1
  while (at < template.length) {
    const char = template[at]
    if (char === quote) return at + 1
    if (quote !== "`" && char === "\\") at++
    else if (quote !== "`" && char === "\n") return -1
    at++
  }
  return -1
}

/** What an action puts in the script: text as written, or a reference to a value. */
function actionOf(
  body: string,
  written: string,
  at: number,
): Result.Result<string | Reference, Found> {
  if (body.startsWith("/*")) return Result.succeed("")
  if (/^`[^`]*`$/.test(body)) return Result.succeed(body.slice(1, -1))
  if (body.startsWith('"') && body.endsWith('"')) {
    try {
      const constant: unknown = JSON.parse(body)
      if (typeof constant === "string") return Result.succeed(constant)
    } catch {
      // Not a constant JSON can read, such as one with a Go-only escape.
    }
  }
  const input = INPUT.exec(body)
  if (input) {
    const path = input[1]!.slice(1).split(".")
    return Result.succeed({
      written,
      at,
      key: `inputs.${path.join(".")}`,
      source: { _tag: "Input", path },
    })
  }
  const output = OUTPUT.exec(body)
  if (output) {
    const block = toBlockId(output[1]!)
    return Result.succeed({
      written,
      at,
      key: `outputs.${block}.${output[2]!}`,
      source: { _tag: "Output", block, key: output[2]! },
    })
  }
  return Result.fail({
    at,
    message: `\`${written}\` is not a value Runbooks can insert. A script's \`{{ }}\` may name a value, \`{{ .inputs.<name> }}\` or \`{{ .outputs.<block>.<key> }}\`, and nothing else: no condition, pipe or function.`,
  })
}

/** The value a reference names, as text, redacted. */
function valueOf(
  reference: Reference,
  sources: ValueSources,
): Result.Result<Redacted.Redacted<string>, Found> {
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

// ---------------------------------------------------------------------------
// Where each reference stands in the script
// ---------------------------------------------------------------------------

type Frame =
  /** Commands: the script itself, or `$(...)`, which ends at the `)` that closes it. */
  | { readonly kind: "code"; readonly inSubstitution: boolean; depth: number }
  | { readonly kind: "single" | "double" | "ansi" | "backquote" | "comment" }
  /** `${...}` and arithmetic, each ending when its brackets balance. */
  | { readonly kind: "parameter" | "arithmetic"; depth: number }
  | {
      readonly kind: "heredoc"
      readonly delimiter: string
      readonly quoted: boolean
      readonly stripTabs: boolean
      atLineStart: boolean
    }

type Heredoc = Extract<Frame, { kind: "heredoc" }>

/** How `name` expands where `frame` is, or why it may not stand there. */
function expandedIn(frame: Frame, name: string): string | { readonly refused: string } {
  switch (frame.kind) {
    case "code":
    case "comment":
      return `"\${${name}}"`
    case "double":
      return `\${${name}}`
    case "single":
      return `'"\${${name}}"'`
    case "heredoc":
      return frame.quoted
        ? { refused: "in a heredoc whose delimiter is quoted, where bash expands no variable" }
        : `\${${name}}`
    case "ansi":
      return { refused: "inside `$'...'`, where bash expands no variable" }
    case "backquote":
      return { refused: "inside backquotes; use `$(...)` instead" }
    case "parameter":
      return { refused: "inside `${...}`" }
    case "arithmetic":
      return { refused: "inside arithmetic, where bash would evaluate the value as an expression" }
  }
}

/** Each `MARK` in `text` replaced by its variable, quoted for where it stands. Adds a problem to `found` for each reference refused. */
function quoteAll(
  text: string,
  references: ReadonlyArray<Reference>,
  variables: ReadonlyArray<string>,
  found: Found[],
): string {
  const stack: Frame[] = [{ kind: "code", inSubstitution: false, depth: 0 }]
  const pending: Heredoc[] = []
  const inserted: string[] = []
  const refused = new Set<number>()

  /** Refuses the reference at `MARK` number `index`, once. */
  const refuseAt = (index: number, where: string) => {
    if (refused.has(index)) return
    refused.add(index)
    const { at, written } = references[index]!
    found.push({
      at,
      message: `\`${written}\` is ${where}, so Runbooks cannot insert its value. Set a variable to it first, \`NAME=${written}\`, and use \`$NAME\` there.`,
    })
  }
  /** Refuses the reference at the next `MARK`, and steps past the character before it. */
  const refuse = (where: string): number => {
    refuseAt(inserted.length, where)
    return 1
  }
  /** At `$`: an expansion that opens a frame, and how many characters it takes. */
  const expansion = (at: number): number => {
    if (text[at + 1] === MARK) return refuse("right after a `$`")
    if (text.startsWith("$((", at)) {
      stack.push({ kind: "arithmetic", depth: 0 })
      return 3
    }
    if (text.startsWith("$(", at)) {
      stack.push({ kind: "code", inSubstitution: true, depth: 0 })
      return 2
    }
    if (text.startsWith("${", at)) {
      stack.push({ kind: "parameter", depth: 1 })
      return 2
    }
    return 1
  }
  /** At `\`: the escaped character goes with it. */
  const escape = (at: number): number => (text[at + 1] === MARK ? refuse("right after a `\\`") : 2)

  let at = 0
  while (at < text.length) {
    const frame = stack.at(-1)!
    const char = text[at]!
    let step: number = 1

    if (frame.kind === "heredoc" && frame.atLineStart) {
      frame.atLineStart = false
      const end = text.indexOf("\n", at)
      const line = text.slice(at, end < 0 ? text.length : end)
      if ((frame.stripTabs ? line.replace(/^\t+/, "") : line) === frame.delimiter) {
        stack.pop()
        const next = pending.shift()
        if (next !== undefined) stack.push(next)
        at = end < 0 ? text.length : end + 1
        continue
      }
    }

    if (char === MARK) {
      const expanded = expandedIn(frame, variables[inserted.length]!)
      if (typeof expanded !== "string") refuseAt(inserted.length, expanded.refused)
      inserted.push(typeof expanded === "string" ? expanded : "")
      at++
      continue
    }

    switch (frame.kind) {
      case "code":
        if (char === "\\") step = escape(at)
        else if (char === "'") stack.push({ kind: "single" })
        else if (char === '"') stack.push({ kind: "double" })
        else if (char === "`") stack.push({ kind: "backquote" })
        else if (char === "$" && text[at + 1] === "'") {
          stack.push({ kind: "ansi" })
          step = 2
        } else if (char === "$") step = expansion(at)
        else if (char === "(" && text[at + 1] === "(") {
          stack.push({ kind: "arithmetic", depth: 0 })
          step = 2
        } else if (char === "(") frame.depth++
        else if (char === ")") {
          if (frame.depth > 0) frame.depth--
          else if (frame.inSubstitution) stack.pop()
        } else if (char === "#" && startsWord(text, at)) stack.push({ kind: "comment" })
        else if (text.startsWith("<<<", at)) step = 3
        else if (text.startsWith("<<", at)) {
          const heredoc = heredocAt(text, at)
          // The operator and its word are stepped over, so each reference in the word is refused here.
          for (const operatorChar of text.slice(at, at + heredoc.length))
            if (operatorChar === MARK) {
              refuseAt(inserted.length, "in a heredoc's delimiter")
              inserted.push("")
            }
          if (heredoc.delimiter !== "") pending.push(heredoc)
          step = heredoc.length
        } else if (char === "\n" && pending.length > 0) stack.push(pending.shift()!)
        break
      case "single":
        if (char === "'") stack.pop()
        break
      case "double":
        if (char === '"') stack.pop()
        else if (char === "\\") step = escape(at)
        else if (char === "`") stack.push({ kind: "backquote" })
        else if (char === "$") step = expansion(at)
        break
      case "ansi":
        if (char === "\\") step = 2
        else if (char === "'") stack.pop()
        break
      case "backquote":
        if (char === "\\") step = 2
        else if (char === "`") stack.pop()
        break
      case "comment":
        // The newline is the commands' again: a heredoc may start after it.
        if (char === "\n") {
          stack.pop()
          step = 0
        }
        break
      case "parameter":
        if (char === "\\") step = 2
        else if (char === '"') stack.push({ kind: "double" })
        else if (char === "'" && stack.at(-2)?.kind !== "double") stack.push({ kind: "single" })
        else if (char === "$") step = expansion(at)
        else if (char === "{") frame.depth++
        else if (char === "}" && --frame.depth === 0) stack.pop()
        break
      case "arithmetic":
        if (char === "(") frame.depth++
        else if (char === ")") {
          if (frame.depth > 0) frame.depth--
          else if (text[at + 1] === ")") {
            stack.pop()
            step = 2
          }
        }
        break
      case "heredoc":
        if (char === "\n") frame.atLineStart = true
        else if (frame.quoted) break
        else if (char === "\\") step = escape(at)
        else if (char === "`") stack.push({ kind: "backquote" })
        else if (char === "$") step = expansion(at)
        break
    }
    at += step
  }

  let next = 0
  return text.replaceAll(MARK, () => inserted[next++]!)
}

/** Characters before which a `#` starts a comment. */
const WORD_BREAKS = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"])

const startsWord = (text: string, at: number) => at === 0 || WORD_BREAKS.has(text[at - 1]!)

/** The heredoc whose `<<` is at `at`: its delimiter, unquoted, and how many characters the operator and word take. */
function heredocAt(text: string, at: number): Heredoc & { readonly length: number } {
  let end = at + 2
  const stripTabs = text[end] === "-"
  if (stripTabs) end++
  while (text[end] === " " || text[end] === "\t") end++
  let delimiter = ""
  let quoted = false
  while (end < text.length && !/[\s;&|<>()]/.test(text[end]!)) {
    const char = text[end]!
    if (char === "'" || char === '"') {
      const close = text.indexOf(char, end + 1)
      const stop = close < 0 ? text.length : close
      delimiter += text.slice(end + 1, stop)
      quoted = true
      end = stop + 1
    } else if (char === "\\") {
      delimiter += text[end + 1] ?? ""
      quoted = true
      end += 2
    } else {
      delimiter += char
      end++
    }
  }
  return { kind: "heredoc", delimiter, quoted, stripTabs, atLineStart: true, length: end - at }
}
