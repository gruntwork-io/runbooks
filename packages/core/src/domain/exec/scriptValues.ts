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
 * Refused, each with what to write instead, where bash would not expand the
 * variable, or would evaluate what it holds:
 * - a heredoc whose delimiter is quoted, its delimiter, `$'...'`, backquotes,
 *   and right after a `\` or a `$`;
 * - anywhere inside `${...}` or arithmetic (`$((...))`, `((...))`, `$[...]`),
 *   quotes and `$(...)` there included, and in an array subscript;
 * - a word bash reads as a variable name: the names `read` and `printf -v`
 *   set, `unset`'s operands, the names `declare`, `typeset` and `local`
 *   declare, and the operand of `-v` and `-R` in `[[ ]]`, `test` and `[`;
 * - a word bash evaluates as arithmetic: `let`'s operands, the operands of
 *   `-eq`, `-ne`, `-lt`, `-le`, `-gt` and `-ge` in `[[ ]]`, and a value
 *   assigned to a variable `declare -i` (or `typeset`, `local`) makes an
 *   integer, wherever in the script that is;
 * - a word bash runs as code: `eval`'s operands, `trap`'s action, `alias`,
 *   `mapfile -C`, `compgen -C` and `-W`, and a value assigned to `PS4`,
 *   `BASH_ENV` or `ENV`;
 * - a value assigned to a reference variable (`declare -n`); an option word
 *   of any builtin here; and the first operand of `read`, `printf`,
 *   `mapfile` or `compgen` when it starts with the value, which a value that
 *   starts with `-` makes an option;
 * - in or after a `$(...)` that bash 3.2, the macOS default, ends at another
 *   `)` (one in a heredoc, or after a `case` pattern with no `(`): 3.2 would
 *   read it with other quotes.
 * A reference inside a `$(...)` counts as part of the word that holds it, so
 * `let n=$(echo {{ .inputs.v }})` is refused too. `read -p`'s prompt, the
 * value `printf -v` writes, and a command after `local -i n` take a value as
 * usual. The positions were found by running bash 3.2.57 and 5.2.37.
 *
 * Not covered:
 * - Nested programs. In single quotes the value goes into the text of
 *   whatever program the quotes hold, `awk '{ print "{{ .inputs.v }}" }'`,
 *   `jq`, `sed`, `sh -c`, `ssh host '...'`, `python -c`, and that program
 *   reads it as its own code. A heredoc fed to `bash`, `python` or
 *   `source /dev/stdin` is the same. Verbatim insertion did the same, so
 *   this is no regression; only a value the program reads from the
 *   environment, as in `awk '{ print ENVIRON["NAME"] }'`, is safe there.
 * - A value the script passes on through a variable: `x={{ .inputs.v }}`
 *   then `$((x))`, `eval "$x"`, `bash -c "$x"`, or `read n` into an integer.
 * - A value used as a command's name runs as that command.
 * - Builtins reached another way: a name built at run time, a function or
 *   alias named like one, or `enable`.
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

/** A reference in the text: its number, and where its `MARK` is. */
interface Mark {
  readonly index: number
  readonly at: number
}

/** A word being read: where it starts, and each reference in it, those in a `$(...)` it holds included. */
interface OpenWord {
  readonly start: number
  readonly marks: Mark[]
}

/** A word read, as written. */
interface Word extends OpenWord {
  readonly text: string
}

/** What a word is to the builtin given it. */
type Use = "text" | "name" | "code" | "arithmetic"

/** A builtin that reads one of its words as a variable name, code or arithmetic. */
interface Builtin {
  /** Its option letters that take an argument, and what the argument is; undefined if it reads no options. */
  readonly options?: Readonly<Record<string, Use>>
  /** What each operand is, by position; the last stands for the rest. */
  readonly operands: readonly [Use, ...Use[]]
  /** Its operands are `NAME=VALUE`, and what a reference in NAME is. */
  readonly declares?: { readonly name: Use }
  /** Operands that make the next one a variable name. */
  readonly namesAfter?: ReadonlySet<string>
}

const MAPFILE: Builtin = {
  options: { C: "code", c: "text", d: "text", n: "text", O: "text", s: "text", u: "text" },
  operands: ["text"],
}
const DECLARE: Builtin = { options: {}, operands: ["text"], declares: { name: "name" } }
const EXPORT: Builtin = { options: {}, operands: ["text"], declares: { name: "text" } }
const TEST: Builtin = { operands: ["text"], namesAfter: new Set(["-v", "-R"]) }

/** Each bash builtin that evaluates a word it is given, as bash 3.2 or 5.2 does. */
const BUILTINS: ReadonlyMap<string, Builtin> = new Map([
  [
    "read",
    {
      options: {
        a: "name",
        d: "text",
        i: "text",
        n: "text",
        N: "text",
        p: "text",
        t: "text",
        u: "text",
      },
      operands: ["name"],
    },
  ],
  ["printf", { options: { v: "name" }, operands: ["text"] }],
  ["let", { operands: ["arithmetic"] }],
  ["eval", { operands: ["code"] }],
  ["trap", { options: {}, operands: ["code", "text"] }],
  ["unset", { options: {}, operands: ["name"] }],
  ["mapfile", MAPFILE],
  ["readarray", MAPFILE],
  [
    "compgen",
    {
      options: {
        A: "text",
        C: "code",
        F: "text",
        G: "text",
        o: "text",
        P: "text",
        S: "text",
        W: "code",
        X: "text",
      },
      operands: ["text"],
    },
  ],
  ["alias", { options: {}, operands: ["code"] }],
  ["declare", DECLARE],
  ["typeset", DECLARE],
  ["local", DECLARE],
  ["export", EXPORT],
  ["readonly", EXPORT],
  ["test", TEST],
  ["[", TEST],
])

/** `[[ ]]` operators whose operands bash evaluates as arithmetic. */
const ARITHMETIC_TESTS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"])

/** The arguments of a builtin in `BUILTINS`. */
interface BuiltinArguments {
  readonly kind: "builtin"
  readonly name: string
  readonly builtin: Builtin
  /** It is still reading options. */
  options: boolean
  /** The option whose argument the next word is, if one is. */
  argument: { readonly letter: string; readonly use: Use } | undefined
  /** The option letters it was given with `-`. */
  readonly set: Set<string>
  operands: number
  /** The operand before, as written. */
  previous: string | undefined
}

/** What the next word of the command being read is. */
type Reading =
  /** The command's name, or a word before it: an assignment, a reserved word, `command` or `builtin`. */
  | { readonly kind: "name"; readonly afterPrefix: boolean }
  /** `case WORD in`, with how many words after `case` are read. */
  | { readonly kind: "case"; words: number }
  /** The name after `function`. */
  | { readonly kind: "function" }
  /** `[[ ... ]]`, until its `]]`, with its words and operators. */
  | { readonly kind: "test"; readonly words: Word[] }
  | BuiltinArguments
  /** The arguments of any other command, which it gets as text. */
  | { readonly kind: "text" }

const COMMAND_NAME: Reading = { kind: "name", afterPrefix: false }

/** Commands: the script itself, or `$(...)`, `<(...)` or `>(...)`, each ending at the `)` that closes it. */
interface Code {
  readonly kind: "code"
  /** Where its `$(`, `<(` or `>(` is; undefined for the script itself. */
  readonly opensAt: number | undefined
  /** Subshells, and extglob groups in a `case` pattern, open in it. */
  depth: number
  /** The word being read, if one is. */
  word: OpenWord | undefined
  reading: Reading
  /** The next word is a redirection's target, which is no part of the command. */
  redirect: boolean
  /** Each `case` open in it, innermost last: reading patterns, or the commands after them. */
  readonly cases: Array<"patterns" | "commands">
}

interface Heredoc {
  readonly kind: "heredoc"
  readonly delimiter: string
  readonly quoted: boolean
  readonly stripTabs: boolean
  atLineStart: boolean
}

type Frame =
  | Code
  | Heredoc
  | { readonly kind: "single" | "double" | "ansi" | "backquote" | "comment" }
  /** `${...}`, ending when its braces balance. */
  | { readonly kind: "parameter"; depth: number }
  /** `$((...))` and `((...))`, ending at `))`, and `$[...]`, ending at `]`. */
  | { readonly kind: "arithmetic"; readonly close: "))" | "]"; depth: number }
  /** The elements of `NAME=(...)`, ending at the `)` that closes it, with where the element being read starts. */
  | { readonly kind: "array"; depth: number; element: number | undefined }

const commandsIn = (opensAt: number | undefined): Code => ({
  kind: "code",
  opensAt,
  depth: 0,
  word: undefined,
  reading: COMMAND_NAME,
  redirect: false,
  cases: [],
})

/** Why a reference may not stand where it is, and what to write instead. */
interface Refusal {
  readonly where: string
  readonly instead: (written: string) => string
}

const refusal = (where: string): Refusal => ({
  where,
  instead: (written) =>
    `Set a variable to it first, \`NAME=${written}\`, and use \`"$NAME"\` there.`,
})

const EVALUATES: Readonly<
  Record<
    Exclude<Use, "text">,
    { readonly as: string; readonly instead: (written: string) => string }
  >
> = {
  name: {
    as: "reads the value as a variable name, and evaluates a subscript in it",
    instead: () => "Name the variable in the script.",
  },
  code: {
    as: "runs the value as code",
    instead: (written) =>
      `Set a variable to it first, \`NAME=${written}\`, and have the code expand \`"$NAME"\` as it runs, as in \`trap 'echo "$NAME"' EXIT\`.`,
  },
  arithmetic: {
    as: "evaluates the value as arithmetic",
    instead: (written) =>
      `Set a variable to it first, \`NAME=${written}\`, check it is a number, \`[[ $NAME =~ ^-?[0-9]+$ ]]\`, and use \`$NAME\` there.`,
  },
}

/** `what` is a place bash reads a value as `use`. */
const evaluated = (use: Exclude<Use, "text">, what: string): Refusal => ({
  where: `${what}, where bash ${EVALUATES[use].as}`,
  instead: EVALUATES[use].instead,
})

const IN_PARAMETER: Refusal = {
  where: "inside `${...}`, where bash may evaluate it as a subscript or an offset",
  instead: (written) =>
    `Set a variable to it first, \`NAME=${written}\`, and use \`$NAME\` only as a default or replacement value, as in \`\${X:-$NAME}\`.`,
}

const IN_ARITHMETIC = evaluated("arithmetic", "inside arithmetic")

const IN_SUBSCRIPT = evaluated("arithmetic", "in an array subscript")

const AFTER_BASH32_DIVERGES: Refusal = {
  where:
    "in or after a `$(...)` that bash 3.2, the macOS default, ends early: at a `)` in a heredoc, or at the `)` after a `case` pattern",
  instead: () =>
    "Start each `case` pattern in the `$(...)` with `(`, as in `(a)`, and move any heredoc out of it.",
}

/** How `name` expands where the innermost frame of `stack` is, or why it may not stand there. */
function expandedIn(stack: ReadonlyArray<Frame>, name: string): string | Refusal {
  for (let index = stack.length - 1; index >= 0; index--) {
    const { kind } = stack[index]!
    if (kind === "parameter") return IN_PARAMETER
    if (kind === "arithmetic") return IN_ARITHMETIC
  }
  const frame = stack.at(-1)!
  switch (frame.kind) {
    case "code":
    case "array":
    case "comment":
      return `"\${${name}}"`
    case "double":
      return `\${${name}}`
    case "single":
      return `'"\${${name}}"'`
    case "heredoc":
      return frame.quoted
        ? refusal("in a heredoc whose delimiter is quoted, where bash expands no variable")
        : `\${${name}}`
    case "ansi":
      return refusal("inside `$'...'`, where bash expands no variable")
    case "backquote":
      return { where: "inside backquotes", instead: () => "Use `$(...)` instead." }
    case "parameter":
      return IN_PARAMETER
    case "arithmetic":
      return IN_ARITHMETIC
  }
}

/** Reserved words after which a command starts. */
const STARTS_COMMAND = new Set([
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "!",
  "time",
  "{",
  "}",
  "fi",
  "done",
])

/** A word's text as bash reads it, if no expansion or reference is in it. */
const plainOf = (word: string): string | undefined =>
  /[$`\0]/.test(word) ? undefined : word.replace(/\\(.)|["']/gs, "$1")

const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*/

/** The index after the `]` that closes the `[` at `open`, or -1. */
function subscriptEnd(word: string, open: number): number {
  let depth = 0
  for (let at = open; at < word.length; at++) {
    if (word[at] === "[") depth++
    else if (word[at] === "]" && --depth === 0) return at + 1
  }
  return -1
}

/** Each `MARK` in `text` replaced by its variable, quoted for where it stands. Adds a problem to `found` for each reference refused. */
function quoteAll(
  text: string,
  references: ReadonlyArray<Reference>,
  variables: ReadonlyArray<string>,
  found: Found[],
): string {
  const stack: Frame[] = [commandsIn(undefined)]
  const pending: Heredoc[] = []
  const inserted: string[] = []
  const refused = new Set<number>()
  /** Where the first `$(` is that bash 3.2 ends at another `)`, if one is. */
  let bash32Diverges: number | undefined
  /** Variables whose value bash evaluates when it is assigned or expanded. */
  const evaluating = new Map<string, { readonly use: Exclude<Use, "text">; readonly what: string }>(
    [
      ["PS4", { use: "code", what: "`PS4`, the prompt bash expands as it traces each command" }],
      ["BASH_ENV", { use: "code", what: "`BASH_ENV`, which each bash the script starts expands" }],
      ["ENV", { use: "code", what: "`ENV`, which an interactive POSIX-mode bash expands" }],
    ],
  )
  /** The references in each value assigned to a variable, checked against `evaluating` once it is known. */
  const assignments: Array<{ readonly variable: string; readonly marks: ReadonlyArray<Mark> }> = []

  /** Refuses the reference at `MARK` number `index`, once. */
  const refuseAt = (index: number, { where, instead }: Refusal) => {
    if (refused.has(index)) return
    refused.add(index)
    const { at, written } = references[index]!
    found.push({
      at,
      message: `\`${written}\` is ${where}, so Runbooks cannot insert its value. ${instead(written)}`,
    })
  }
  const refuseAll = (marks: ReadonlyArray<Mark>, why: Refusal) => {
    for (const { index } of marks) refuseAt(index, why)
  }
  /** At `\`: a reference right after it is refused; any other character goes with it. */
  const escape = (at: number): number => {
    if (text[at + 1] !== MARK) return 2
    refuseAt(inserted.length, refusal("right after a `\\`"))
    return 1
  }
  /** At `$`: an expansion that opens a frame, and how many characters it takes. */
  const expansion = (at: number): number => {
    const next = text[at + 1]
    if (next === MARK) {
      refuseAt(inserted.length, refusal("right after a `$`"))
      return 1
    }
    if (text.startsWith("$((", at)) {
      stack.push({ kind: "arithmetic", close: "))", depth: 0 })
      return 3
    }
    if (next === "(") stack.push(commandsIn(at))
    else if (next === "[") stack.push({ kind: "arithmetic", close: "]", depth: 0 })
    else if (next === "{") stack.push({ kind: "parameter", depth: 1 })
    else return 1
    return 2
  }

  /** If `word` is an assignment, `NAME=VALUE` or `NAME[SUBSCRIPT]=VALUE`, reads it and says so. */
  const assigned = (word: Word): boolean => {
    const variable = VARIABLE.exec(word.text)?.[0]
    if (variable === undefined) return false
    let end = variable.length
    if (word.text[end] === "[") end = subscriptEnd(word.text, end)
    if (end < 0) return false
    const equals = word.text.startsWith("+=", end) ? end + 1 : end
    if (word.text[equals] !== "=") return false
    refuseAll(
      word.marks.filter(({ at }) => at < word.start + equals),
      IN_SUBSCRIPT,
    )
    assignments.push({
      variable,
      marks: word.marks.filter(({ at }) => at > word.start + equals),
    })
    return true
  }
  /** Reads an operand of `declare` and the like: `NAME`, or `NAME=VALUE`. */
  const declared = (args: BuiltinArguments, name: Use, word: Word) => {
    const equals = word.text.indexOf("=")
    const nameEnd = word.start + (equals < 0 ? word.text.length : equals)
    if (name !== "text")
      refuseAll(
        word.marks.filter(({ at }) => at < nameEnd),
        evaluated(name, `in a name \`${args.name}\` declares`),
      )
    const variable = VARIABLE.exec(word.text)?.[0]
    const value = word.marks.filter(({ at }) => at > nameEnd)
    const letter = args.set.has("i") ? "i" : args.set.has("n") ? "n" : undefined
    if (letter === undefined) {
      if (variable !== undefined && equals >= 0) assignments.push({ variable, marks: value })
      return
    }
    const use = letter === "i" ? "arithmetic" : "name"
    if (variable !== undefined)
      evaluating.set(variable, {
        use,
        what: `\`${variable}\`, which \`${args.name} -${letter}\` makes ${letter === "i" ? "an integer" : "a reference to the variable it names"}`,
      })
    refuseAll(value, evaluated(use, `a value \`${args.name} -${letter}\` assigns`))
  }
  /** Reads the option word `word`, `-abc`, given to a builtin. */
  const readOptions = (args: BuiltinArguments, word: Word) => {
    for (let at = 1; at < word.text.length; at++) {
      const letter = word.text[at]!
      if (letter === MARK || letter === "$" || letter === "`") {
        refuseAll(word.marks, {
          where: `in an option of \`${args.name}\`, which the value would choose`,
          instead: () => "Write the option in the script.",
        })
        return
      }
      if (word.text.startsWith("-")) args.set.add(letter)
      const use = args.builtin.options?.[letter]
      if (use === undefined) continue
      if (at === word.text.length - 1) args.argument = { letter, use }
      else if (use !== "text")
        refuseAll(word.marks, evaluated(use, `the argument of \`${args.name} -${letter}\``))
      return
    }
  }
  /** Reads a word given to a builtin in `BUILTINS`. */
  const readArgument = (args: BuiltinArguments, word: Word) => {
    const { name, builtin } = args
    if (args.argument !== undefined) {
      const { letter, use } = args.argument
      args.argument = undefined
      if (use !== "text")
        refuseAll(word.marks, evaluated(use, `the argument of \`${name} -${letter}\``))
      return
    }
    const firstOperand = args.options
    if (args.options) {
      if (word.text === "--") {
        args.options = false
        return
      }
      if (/^-./s.test(word.text) || (builtin.declares !== undefined && /^\+./s.test(word.text))) {
        readOptions(args, word)
        return
      }
      args.options = false
    }
    const operand = args.operands++
    const use = builtin.namesAfter?.has(args.previous ?? "")
      ? "name"
      : builtin.operands[Math.min(operand, builtin.operands.length - 1)]!
    args.previous = word.text
    if (builtin.declares !== undefined) declared(args, builtin.declares.name, word)
    else if (use !== "text") refuseAll(word.marks, evaluated(use, `an operand of \`${name}\``))
    // A value there that starts with `-` would be read as an option, and may name a variable or code.
    if (
      firstOperand &&
      /^["']*\0/.test(word.text) &&
      Object.values(builtin.options ?? {}).some((optionUse) => optionUse !== "text")
    )
      refuseAll(word.marks, {
        where: `the first operand of \`${name}\`, which a value that starts with \`-\` would make an option`,
        instead: () => "Put `--` before it.",
      })
  }
  /** Refuses each reference in an operand bash evaluates in the words of `[[ ... ]]`. */
  const checkTest = (words: ReadonlyArray<Word>) => {
    for (let at = 0; at < words.length; at++) {
      const operator = words[at]!.text
      if (ARITHMETIC_TESTS.has(operator))
        for (const side of [words[at - 1], words[at + 1]])
          refuseAll(
            side?.marks ?? [],
            evaluated("arithmetic", `an operand of \`${operator}\` in \`[[ ]]\``),
          )
      else if (operator === "-v" || operator === "-R")
        refuseAll(
          words[at + 1]?.marks ?? [],
          evaluated("name", `the operand of \`${operator}\` in \`[[ ]]\``),
        )
    }
  }
  /** Reads a word of a command in `frame`. */
  const readWord = (frame: Code, word: Word) => {
    const reading = frame.reading
    switch (reading.kind) {
      case "name": {
        if (STARTS_COMMAND.has(word.text)) return
        if (word.text === "case") frame.reading = { kind: "case", words: 0 }
        else if (word.text === "function") frame.reading = { kind: "function" }
        else if (word.text === "[[") frame.reading = { kind: "test", words: [] }
        else if (assigned(word)) return
        else {
          const name = plainOf(word.text)
          const builtin = name === undefined ? undefined : BUILTINS.get(name)
          if (
            name === "command" ||
            name === "builtin" ||
            (reading.afterPrefix && name?.startsWith("-"))
          )
            frame.reading = { kind: "name", afterPrefix: true }
          else if (name === undefined || builtin === undefined) frame.reading = { kind: "text" }
          else
            frame.reading = {
              kind: "builtin",
              name,
              builtin,
              options: builtin.options !== undefined,
              argument: undefined,
              set: new Set(),
              operands: 0,
              previous: undefined,
            }
        }
        return
      }
      case "case":
        if (++reading.words === 2 && word.text === "in") {
          frame.cases.push("patterns")
          frame.reading = COMMAND_NAME
        }
        return
      case "function":
        frame.reading = COMMAND_NAME
        return
      case "test":
        if (word.text !== "]]") reading.words.push(word)
        else {
          checkTest(reading.words)
          frame.reading = { kind: "text" }
        }
        return
      case "builtin":
        readArgument(reading, word)
        return
      case "text":
        return
    }
  }

  const startWord = (frame: Code, at: number) => {
    frame.word ??= { start: at, marks: [] }
  }
  /** Ends the word being read, if one is, at `at`. */
  const endWord = (frame: Code, at: number) => {
    const open = frame.word
    if (open === undefined) return
    frame.word = undefined
    if (frame.redirect) {
      frame.redirect = false
      return
    }
    const word: Word = { ...open, text: text.slice(open.start, at) }
    const reading = frame.cases.at(-1)
    if (reading !== undefined && word.text === "esac" && frame.reading.kind === "name") {
      frame.cases.pop()
      return
    }
    if (reading !== "patterns") readWord(frame, word)
  }
  /** Ends the command being read. */
  const endCommand = (frame: Code, at: number) => {
    endWord(frame, at)
    if (frame.reading.kind === "test") checkTest(frame.reading.words)
    frame.reading = COMMAND_NAME
    frame.redirect = false
  }
  const testWords = (frame: Code) =>
    frame.reading.kind === "test" ? frame.reading.words : undefined

  /** One step in commands: how many characters it takes. */
  const inCode = (frame: Code, at: number): number => {
    const char = text[at]!
    const next = text[at + 1]
    if (char === "\n") {
      // `case WORD` may go on to its `in`, and `[[` to its `]]`, on the next line.
      const reading = frame.reading
      if ((reading.kind === "case" && reading.words < 2) || reading.kind === "test")
        endWord(frame, at)
      else endCommand(frame, at)
      if (pending.length > 0) stack.push(pending.shift()!)
      return 1
    }
    if (frame.reading.kind === "test" && "()<>&|".includes(char)) {
      endWord(frame, at)
      // Unless the word it ended was `]]`, the character is an operator of `[[`.
      const words = testWords(frame)
      if (words !== undefined) {
        const operator = (char === "&" || char === "|") && next === char ? char + char : char
        words.push({ start: at, marks: [], text: operator })
        return operator.length
      }
    }
    const inPatterns = frame.cases.at(-1) === "patterns"
    switch (char) {
      case " ":
      case "\t":
        endWord(frame, at)
        return 1
      case "\\":
        if (next === "\n") return 2
        startWord(frame, at)
        return escape(at)
      case "'":
      case '"':
      case "`":
        startWord(frame, at)
        stack.push({ kind: char === "'" ? "single" : char === '"' ? "double" : "backquote" })
        return 1
      case "$":
        startWord(frame, at)
        if (next === "'") {
          stack.push({ kind: "ansi" })
          return 2
        }
        return expansion(at)
      case "#":
        if (frame.word === undefined) stack.push({ kind: "comment" })
        return 1
      case ";":
        endCommand(frame, at)
        if (next !== ";" && next !== "&") return 1
        // `;;`, `;&` and `;;&` end the commands after a `case` pattern.
        if (frame.cases.length > 0) frame.cases[frame.cases.length - 1] = "patterns"
        return text.startsWith(";;&", at) ? 3 : 2
      case "&":
        if (next === ">") {
          endWord(frame, at)
          frame.redirect = true
          return text.startsWith("&>>", at) ? 3 : 2
        }
        endCommand(frame, at)
        return 1
      case "|":
        if (inPatterns) endWord(frame, at)
        else endCommand(frame, at)
        return 1
      case "(":
        if (inPatterns) {
          // An extglob group inside a pattern; a `(` before a pattern opens nothing.
          if (frame.word !== undefined) frame.depth++
          return 1
        }
        if (
          frame.word !== undefined &&
          /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/.test(text.slice(frame.word.start, at))
        ) {
          stack.push({ kind: "array", depth: 0, element: undefined })
          return 1
        }
        endCommand(frame, at)
        if (next === "(") {
          stack.push({ kind: "arithmetic", close: "))", depth: 0 })
          return 2
        }
        frame.depth++
        return 1
      case ")":
        // The word before it may be the `esac` that ends the patterns.
        endWord(frame, at)
        if (frame.cases.at(-1) === "patterns" && frame.depth === 0) {
          frame.cases[frame.cases.length - 1] = "commands"
          return 1
        }
        endCommand(frame, at)
        if (frame.depth > 0) frame.depth--
        else if (frame.opensAt !== undefined) {
          if (bash32SubstitutionEnd(text, frame.opensAt + 2) !== at)
            bash32Diverges = Math.min(bash32Diverges ?? frame.opensAt, frame.opensAt)
          stack.pop()
        }
        return 1
      case "<":
      case ">": {
        // A file descriptor right before it, as in `2>` or `{fd}>`, is part of the redirection.
        if (
          frame.word !== undefined &&
          /^(\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(text.slice(frame.word.start, at))
        )
          frame.word = undefined
        else endWord(frame, at)
        if (next === "(") {
          startWord(frame, at)
          stack.push(commandsIn(at))
          return 2
        }
        if (text.startsWith("<<<", at)) {
          frame.redirect = true
          return 3
        }
        if (text.startsWith("<<", at)) {
          const heredoc = heredocAt(text, at)
          // The operator and its word are stepped over, so each reference in the word is refused here.
          for (const operatorChar of text.slice(at, at + heredoc.length))
            if (operatorChar === MARK) {
              refuseAt(inserted.length, refusal("in a heredoc's delimiter"))
              inserted.push("")
            }
          if (heredoc.delimiter !== "") pending.push(heredoc)
          return heredoc.length
        }
        frame.redirect = true
        return next === ">" || next === "&" || (char === ">" && next === "|") ? 2 : 1
      }
      default:
        startWord(frame, at)
        return 1
    }
  }

  /** One step in the elements of `NAME=(...)`: how many characters it takes. */
  const inArray = (frame: Extract<Frame, { kind: "array" }>, at: number): number => {
    const char = text[at]!
    if (char === " " || char === "\t" || char === "\n") {
      frame.element = undefined
      return 1
    }
    if (char === "#" && frame.element === undefined) {
      stack.push({ kind: "comment" })
      return 1
    }
    frame.element ??= at
    switch (char) {
      case "\\":
        return escape(at)
      case "'":
      case '"':
      case "`":
        stack.push({ kind: char === "'" ? "single" : char === '"' ? "double" : "backquote" })
        return 1
      case "$":
        if (text[at + 1] !== "'") return expansion(at)
        stack.push({ kind: "ansi" })
        return 2
      case "(":
        frame.depth++
        return 1
      case ")":
        if (frame.depth > 0) frame.depth--
        else stack.pop()
        return 1
      default:
        return 1
    }
  }

  let at = 0
  while (at < text.length) {
    const frame = stack.at(-1)!
    const char = text[at]!

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
      const index = inserted.length
      if (frame.kind === "code") startWord(frame, at)
      if (frame.kind === "array") frame.element ??= at
      // The value is part of each word open around it: one in a `$(...)` is part of the word that holds it.
      if (frame.kind !== "comment")
        for (const outer of stack)
          if (outer.kind === "code") outer.word?.marks.push({ index, at })
          else if (
            outer.kind === "array" &&
            outer.element !== undefined &&
            /^\[[^\]]*$/.test(text.slice(outer.element, at))
          )
            refuseAt(index, IN_SUBSCRIPT)
      const expanded = expandedIn(stack, variables[index]!)
      if (typeof expanded !== "string") refuseAt(index, expanded)
      inserted.push(typeof expanded === "string" ? expanded : "")
      at++
      continue
    }

    let step = 1
    switch (frame.kind) {
      case "code":
        step = inCode(frame, at)
        break
      case "array":
        step = inArray(frame, at)
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
        if (char === "\\") step = escape(at)
        else if (char === "'") stack.pop()
        break
      case "backquote":
        if (char === "\\") step = escape(at)
        else if (char === "`") stack.pop()
        break
      case "comment":
        // The newline is the commands' again: it ends the command, and a heredoc may start after it.
        if (char === "\n") {
          stack.pop()
          step = 0
        }
        break
      case "parameter":
        if (char === "\\") step = escape(at)
        else if (char === '"') stack.push({ kind: "double" })
        else if (char === "'" && stack.at(-2)?.kind !== "double") stack.push({ kind: "single" })
        else if (char === "$") step = expansion(at)
        else if (char === "{") frame.depth++
        else if (char === "}" && --frame.depth === 0) stack.pop()
        break
      case "arithmetic":
        if (char === "$") step = expansion(at)
        else if (char === (frame.close === "]" ? "[" : "(")) frame.depth++
        else if (char === (frame.close === "]" ? "]" : ")")) {
          if (frame.depth > 0) frame.depth--
          else if (frame.close === "]") stack.pop()
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
  // The end of the script ends the command being read.
  for (const frame of stack) if (frame.kind === "code") endCommand(frame, text.length)

  for (const { variable, marks } of assignments) {
    const evaluates = evaluating.get(variable)
    if (evaluates !== undefined)
      refuseAll(marks, evaluated(evaluates.use, `assigned to ${evaluates.what}`))
  }
  if (bash32Diverges !== undefined) {
    let index = 0
    for (let markAt = text.indexOf(MARK); markAt >= 0; markAt = text.indexOf(MARK, markAt + 1)) {
      if (markAt > bash32Diverges) refuseAt(index, AFTER_BASH32_DIVERGES)
      index++
    }
  }

  let next = 0
  return text.replaceAll(MARK, () => inserted[next++]!)
}

/**
 * The `)` that bash 3.2, the macOS default, takes to end a `$(` whose
 * commands start at `start`, or -1. It reads no heredoc and no `case`
 * pattern, so a `)` in either ends the `$(` for it.
 */
function bash32SubstitutionEnd(text: string, start: number): number {
  let depth = 0
  for (let at = start; at < text.length; at++) {
    const char = text[at]!
    if (char === "\\") at++
    else if (char === "'") {
      at = text.indexOf("'", at + 1)
      if (at < 0) return -1
    } else if (char === '"' || char === "`") {
      at = closingQuote(text, at)
      if (at < 0) return -1
    } else if (char === "#" && (at === start || WORD_BREAKS.has(text[at - 1]!))) {
      at = text.indexOf("\n", at)
      if (at < 0) return -1
    } else if (char === "(") depth++
    else if (char === ")") {
      if (depth === 0) return at
      depth--
    }
  }
  return -1
}

/** The index of the quote that closes the one at `start`, past backslash escapes, or -1. */
function closingQuote(text: string, start: number): number {
  const quote = text[start]
  for (let at = start + 1; at < text.length; at++) {
    if (text[at] === "\\") at++
    else if (text[at] === quote) return at
  }
  return -1
}

/** Characters before which a `#` starts a comment. */
const WORD_BREAKS = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"])

/** The heredoc whose `<<` is at `at`: its delimiter, unquoted, and how many characters the operator and word take. */
function heredocAt(text: string, at: number): Heredoc & { readonly length: number } {
  let end = at + 2
  const stripTabs = text[end] === "-"
  if (stripTabs) end++
  while (text[end] === " " || text[end] === "\t") end++
  let delimiter = ""
  let quoted = false
  // Bash ends the word only at a metacharacter, so a `\r` before the newline is part of it.
  while (end < text.length && !/[ \t\n;&|<>()]/.test(text[end]!)) {
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
