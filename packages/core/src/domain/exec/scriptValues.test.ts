import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import * as nodeFs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Redacted, Result, Schema } from "effect"
import { BlockId, type BlockOutputs } from "@runbooks/blocks-core/contract"
import type { FormValues } from "@runbooks/blocks-core/form"
import { insertValues, type ScriptWithValues, type ValueSources } from "./scriptValues.ts"

const blockId = Schema.decodeSync(BlockId)

/** A value that runs a command, splits, globs and closes every kind of quote, if bash reads it as code. */
const HOSTILE = `it's "$(touch pwned)" \`touch pwned\` $HOME * ; touch pwned\nEOF\n'\\`

/** A value that runs `touch m` if bash evaluates it as a subscript or arithmetic, and globs to the file `am`. */
const PAYLOAD = "a[$(touch m)]"

const outputs = (byBlock: Record<string, Record<string, string>>): BlockOutputs =>
  new Map(
    Object.entries(byBlock).map(([block, keys]) => [
      blockId(block),
      new Map(Object.entries(keys).map(([key, value]) => [key, Redacted.make(value)])),
    ]),
  )

const sources = (values: FormValues = {}, given: BlockOutputs = new Map()): ValueSources => ({
  values,
  outputs: given,
})

const inserted = (template: string, from: ValueSources, interpreter = "bash"): ScriptWithValues => {
  const result = insertValues(template, from, interpreter)
  if (Result.isFailure(result))
    throw new Error(
      result.failure
        .map((problem) => `${problem.line}:${problem.column}: ${problem.message}`)
        .join("\n"),
    )
  return result.success
}

const refusedAll = (template: string, from: ValueSources = sources(), interpreter = "bash") => {
  const result = insertValues(template, from, interpreter)
  if (Result.isSuccess(result)) throw new Error(`inserted: ${result.success.script}`)
  return result.failure
}

/** The one problem in a template that has one. */
const refused = (template: string, from: ValueSources = sources(), interpreter = "bash") => {
  const problems = refusedAll(template, from, interpreter)
  expect(problems).toHaveLength(1)
  return problems[0]
}

const folder = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "runbooks-script-values-"))
afterAll(() => nodeFs.rmSync(folder, { recursive: true, force: true }))

/** What bash prints running the script with its variables, in a folder of its own, with no other environment. */
const ranWithBash = (template: string, from: ValueSources): string => {
  const { script, env } = inserted(template, from)
  const cwd = nodeFs.mkdtempSync(nodePath.join(folder, "run-"))
  const variables = Object.fromEntries(
    Object.entries(env).map(([name, value]) => [name, Redacted.value(value)]),
  )
  const ran = spawnSync("/bin/bash", ["-c", script], {
    cwd,
    env: { PATH: "/usr/bin:/bin", ...variables },
    encoding: "utf8",
  })
  expect(ran.stderr).toBe("")
  expect(nodeFs.readdirSync(cwd)).toEqual([])
  return ran.stdout
}

/**
 * `template` with `PAYLOAD` for `.inputs.v`: refused, or run by bash in a folder
 * that holds the file `am`. Either way the payload never runs.
 */
const withPayload = (
  template: string,
): { readonly refused: ReadonlyArray<string> } | { readonly printed: string } => {
  const result = insertValues(template, sources({ v: PAYLOAD }), "bash")
  if (Result.isFailure(result)) return { refused: result.failure.map(({ message }) => message) }
  const cwd = nodeFs.mkdtempSync(nodePath.join(folder, "payload-"))
  nodeFs.writeFileSync(nodePath.join(cwd, "am"), "")
  const variables = Object.fromEntries(
    Object.entries(result.success.env).map(([name, value]) => [name, Redacted.value(value)]),
  )
  const ran = spawnSync("/bin/bash", ["-c", result.success.script], {
    cwd,
    env: { PATH: "/usr/bin:/bin", ...variables },
    encoding: "utf8",
  })
  expect(nodeFs.readdirSync(cwd)).toEqual(["am"])
  return { printed: ran.stdout }
}

describe("a value bash gets exactly as given, never as code", () => {
  const value = sources({ v: HOSTILE })

  it("outside quotes, as one word", () => {
    expect(ranWithBash("printf '<%s>' {{ .inputs.v }}", value)).toBe(`<${HOSTILE}>`)
  })

  it("in double quotes", () => {
    expect(ranWithBash("printf '%s' \"before {{ .inputs.v }} after\"", value)).toBe(
      `before ${HOSTILE} after`,
    )
  })

  it("in single quotes", () => {
    expect(ranWithBash("printf '%s' 'before {{ .inputs.v }} after'", value)).toBe(
      `before ${HOSTILE} after`,
    )
  })

  it("in a heredoc whose delimiter is not quoted, as `<<` and `<<-` write it, and after it ends", () => {
    expect(
      ranWithBash(
        "cat <<EOF\nbefore {{ .inputs.v }} after\nEOF\nprintf '<%s>' {{ .inputs.v }}",
        value,
      ),
    ).toBe(`before ${HOSTILE} after\n<${HOSTILE}>`)
    expect(
      ranWithBash(
        "cat <<-EOF\n\tbefore {{ .inputs.v }} after\n\tEOF\nprintf '<%s>' {{ .inputs.v }}",
        value,
      ),
    ).toBe(`before ${HOSTILE} after\n<${HOSTILE}>`)
  })

  it("in a comment, which stays one, whatever quote it holds", () => {
    expect(ranWithBash("# it's {{ .inputs.v }}\nprintf '<%s>' {{ .inputs.v }}", value)).toBe(
      `<${HOSTILE}>`,
    )
  })

  it("in $(...) inside double quotes, as a word of the commands there, and after it closes", () => {
    expect(
      ranWithBash("printf '%s' \"$(printf '<%s>' {{ .inputs.v }})\" {{ .inputs.v }}", value),
    ).toBe(`<${HOSTILE}>${HOSTILE}`)
  })

  it("assigned to a variable, the way to use one where a reference is refused", () => {
    expect(ranWithBash("NAME={{ .inputs.v }}\nprintf '%s' \"$NAME\"", value)).toBe(HOSTILE)
  })

  it("from another block's output", () => {
    const given = sources({}, outputs({ "make-it": { out: HOSTILE } }))
    expect(ranWithBash("printf '%s' {{ .outputs.make-it.out }}", given)).toBe(HOSTILE)
  })

  it("after a heredoc ends, outside quotes again", () => {
    const script = "cat <<'EOF'\nliteral $HOME\nEOF\nprintf '<%s>' {{ .inputs.v }}"
    expect(ranWithBash(script, value)).toBe(`literal $HOME\n<${HOSTILE}>`)
  })

  it.each([
    ["$((...))", "printf '<%s>' $(( 1 + 2 )) {{ .inputs.v }}", `<3><${HOSTILE}>`],
    [
      "$[...] holding <<, which is no heredoc",
      "printf '<%s>' $[1<<2] {{ .inputs.v }}",
      `<4><${HOSTILE}>`,
    ],
    ["${a:-${b}}", "printf '<%s>' \"${a:-${b:-x}}\" {{ .inputs.v }}", `<x><${HOSTILE}>`],
    [
      "a second heredoc on one line, which holds one",
      "cat <<A; cat <<B\na\nA\n{{ .inputs.v }}\nB\nprintf '<%s>' {{ .inputs.v }}",
      `a\n${HOSTILE}\n<${HOSTILE}>`,
    ],
    [
      "a `case` in $(...) whose patterns start with `(`",
      "printf '%s' \"$(case a in (a) printf '<%s>' {{ .inputs.v }};; esac)\" {{ .inputs.v }}",
      `<${HOSTILE}>${HOSTILE}`,
    ],
  ])("after %s closes, quoted for where it stands", (_, template, printed) => {
    expect(ranWithBash(template, value)).toBe(printed)
  })

  it.each([
    [
      "`read -p`'s prompt",
      'read -p "Region [{{ .inputs.v }}]: " r <<< x; printf \'<%s>\' "$r"',
      "<x>",
    ],
    [
      "what `printf -v` writes",
      "printf -v out '%s' \"{{ .inputs.v }}\"; printf '<%s>' \"$out\"",
      `<${HOSTILE}>`,
    ],
    [
      "a command after `local -i`",
      "f() {\n  local -i n\n  printf '<%s>' {{ .inputs.v }}\n}\nf",
      `<${HOSTILE}>`,
    ],
    [
      "a `declare` value without `-i`",
      "declare n={{ .inputs.v }}; printf '<%s>' \"$n\"",
      `<${HOSTILE}>`,
    ],
    ["an `export` value", "export X={{ .inputs.v }}; printf '<%s>' \"$X\"", `<${HOSTILE}>`],
    ["an array element", "a=({{ .inputs.v }}); printf '<%s>' \"${a[0]}\"", `<${HOSTILE}>`],
    [
      "a redirection's target",
      "printf '<%s>' {{ .inputs.v }} 2>&1 >&2 2>/dev/null",
      `<${HOSTILE}>`,
    ],
    [
      "`[[ == ]]` and `case`, which match it literally",
      "[[ x == {{ .inputs.v }} ]] || printf a; case x in {{ .inputs.v }}) ;; *) printf b;; esac",
      "ab",
    ],
  ])("as %s", (_, template, printed) => {
    expect(ranWithBash(template, value)).toBe(printed)
  })

  it("as `printf`'s first operand after `--`, where a value that starts with `-` is no option", () => {
    expect(ranWithBash("printf -- {{ .inputs.v }}", sources({ v: "-v x" }))).toBe("-v x")
  })

  it("after a heredoc in a script with CRLF line ends, whose delimiter line ends with `\\r` too", () => {
    expect(ranWithBash("cat <<EOF\r\nx\r\nEOF\r\nprintf '<%s>' {{ .inputs.v }}\r\n", value)).toBe(
      `x\r\n<${HOSTILE}\r>`,
    )
    // As bash does, a line ending without `\r` does not end a heredoc whose delimiter has one.
    expect(ranWithBash("cat <<EOF\r\nEOF\nprintf '<%s>' {{ .inputs.v }}\nEOF\r\n", value)).toBe(
      `EOF\nprintf '<%s>' ${HOSTILE}\n`,
    )
  })
})

describe("a value bash never evaluates, run with one that runs a command if it does", () => {
  it.each([
    ["`read`'s variable name", "a=(1); read {{ .inputs.v }} <<< x", "variable name"],
    [
      "`read`'s, after `command`",
      "a=(1); command read -r -- {{ .inputs.v }} <<< x",
      "variable name",
    ],
    ["`read -a`'s variable name", "a=(1); read -a {{ .inputs.v }} <<< x", "variable name"],
    ["`printf -v`'s variable name", "a=(1); printf -v {{ .inputs.v }} '%s' x", "variable name"],
    [
      "`printf`'s first operand, which a value can make `-v`",
      "a=(1); printf {{ .inputs.v }} x",
      "option",
    ],
    ["an operand of `let`", "let n={{ .inputs.v }}", "arithmetic"],
    ["a value from `$(...)` in an operand of `let`", "let n=$(echo {{ .inputs.v }})", "arithmetic"],
    ["the value of `declare -i`", "declare -i n={{ .inputs.v }}", "arithmetic"],
    [
      "the value of `local -i`, after another",
      "f() { local -i m=1 n={{ .inputs.v }}; }; f",
      "arithmetic",
    ],
    [
      "a variable a `declare -i` on an earlier line made an integer",
      "declare -i n\nn={{ .inputs.v }}",
      "arithmetic",
    ],
    [
      "one a `declare -i` on a later line makes an integer",
      "f() { n+={{ .inputs.v }}; }\ndeclare -i n\nf",
      "arithmetic",
    ],
    [
      "a variable a `declare -n` made a reference",
      'a=(1); declare -n r\nr={{ .inputs.v }}; echo "$r"',
      "variable name",
    ],
    [
      "the value of `declare -n`",
      'a=(1); declare -n r={{ .inputs.v }}; echo "$r"',
      "variable name",
    ],
    ["the name `declare` declares", "declare {{ .inputs.v }}=1", "variable name"],
    ["the name `local` declares", "f() { local {{ .inputs.v }}=1; }; f", "variable name"],
    ["an operand of `unset`", "a=(1); unset {{ .inputs.v }}", "variable name"],
    ["an array subscript", "a[{{ .inputs.v }}]=1", "arithmetic"],
    ["an array subscript in `(...)`", "a=([{{ .inputs.v }}]=1)", "arithmetic"],
    ["an element of an integer array", "declare -ai a\na=({{ .inputs.v }})", "arithmetic"],
    ["`[[ -v ]]`", "a=(1); [[ -v {{ .inputs.v }} ]]", "variable name"],
    ["`test -v`", "a=(1); test -v {{ .inputs.v }}", "variable name"],
    ["`[ -v ]`", "a=(1); [ -v {{ .inputs.v }} ]", "variable name"],
    ["the left of `-eq` in `[[ ]]`", "[[ {{ .inputs.v }} -eq 1 ]]", "arithmetic"],
    ["the right of `-lt` in `[[ ]]`, in `(...)`", "[[ ( 1 -lt {{ .inputs.v }} ) ]]", "arithmetic"],
    ["a `$(...)` beside `-ge` in `[[ ]]`", "[[ $(echo {{ .inputs.v }}) -ge 1 ]]", "arithmetic"],
    ["the action of `trap`", "trap 'echo {{ .inputs.v }}' EXIT", "code"],
    ["an operand of `eval`", 'eval "echo {{ .inputs.v }}"', "code"],
    ["the callback of `mapfile -C`", "mapfile -C {{ .inputs.v }} -c 1 a <<< x", "code"],
    ["the word list of `compgen -W`", 'compgen -W "{{ .inputs.v }}" x', "code"],
    ["an alias", "shopt -s expand_aliases; alias x={{ .inputs.v }}\nx", "code"],
    ["`PS4`, which bash expands as it traces", "PS4={{ .inputs.v }}; set -x; true", "code"],
    [
      "`BASH_ENV`, which a bash it starts expands",
      "export BASH_ENV={{ .inputs.v }}\nbash -c true",
      "code",
    ],
  ])("refuses %s", (_, template, evaluatesAs) => {
    expect(withPayload(template)).toEqual({ refused: [expect.stringContaining(evaluatesAs)] })
  })

  it.each([
    ["a subscript, in a double quote inside `${...}`", 'a=(x); echo "${a["{{ .inputs.v }}"]}"'],
    ["a subscript, in `$(...)` inside `${...}`", 'a=(x); echo "${a[$(echo {{ .inputs.v }})]}"'],
    ["arithmetic, in `$(...)` inside `$((...))`", "echo $(( $(echo {{ .inputs.v }}) ))"],
    ["`$[...]` arithmetic", "echo $[ {{ .inputs.v }} ]"],
  ])("refuses %s", (_, template) => {
    expect(withPayload(template)).toEqual({ refused: [expect.stringContaining("{{ .inputs.v }}")] })
  })

  it.each([
    [
      "after `$[1<<2]`, which opens no heredoc",
      "echo $[1<<2]\nprintf '<%s>' {{ .inputs.v }}",
      `4\n<${PAYLOAD}>`,
    ],
    [
      "in a `case` in $(...), whose `(a)` pattern does not end the $(...)",
      "printf '%s' \"$(case a in (a) printf '<%s>' {{ .inputs.v }};; esac)\"",
      `<${PAYLOAD}>`,
    ],
    [
      "after a CRLF heredoc",
      "cat <<EOF\r\nx\r\nEOF\r\nprintf '<%s>' {{ .inputs.v }}\r\n",
      `x\r\n<${PAYLOAD}\r>`,
    ],
  ])("inserts it quoted %s", (_, template, printed) => {
    expect(withPayload(template)).toEqual({ printed })
  })

  it.each([
    [
      "a `case` pattern without `(`",
      "printf '%s' \"$(case a in a) printf '<%s>' {{ .inputs.v }};; esac)\"",
    ],
    ["a `)` in a heredoc", "x=$(cat <<X\na) {{ .inputs.v }}\nX\n); printf '%s' \"$x\""],
  ])(
    "refuses a reference after %s in $(...), where bash 3.2 ends the $(...) early",
    (_, template) => {
      const outcome = withPayload(template)
      expect(outcome).toEqual({ refused: [expect.stringContaining("bash 3.2")] })
    },
  )
})

describe("the variables", () => {
  it("are one per value, however often the script reads it, and hold it redacted", () => {
    const { script, env } = inserted(
      "a={{ .inputs.v }}; b=\"{{ .inputs.v }}\"; c='{{ .outputs.s.k }}'",
      sources({ v: "x" }, outputs({ s: { k: "y" } })),
    )
    expect(script).toBe(
      `export -n RUNBOOK_VALUE_1 RUNBOOK_VALUE_2; a="\${RUNBOOK_VALUE_1}"; b="\${RUNBOOK_VALUE_1}"; c=''"\${RUNBOOK_VALUE_2}"''`,
    )
    expect(Object.keys(env)).toEqual(["RUNBOOK_VALUE_1", "RUNBOOK_VALUE_2"])
    expect(Redacted.isRedacted(env["RUNBOOK_VALUE_1"])).toBe(true)
    expect(Redacted.value(env["RUNBOOK_VALUE_2"]!)).toBe("y")
  })

  it("are in no environment but the script's own, and leave its line numbers as written", () => {
    const { script, env } = inserted(
      [
        `bash -c 'printf "[%s]" "\${RUNBOOK_VALUE_1-unset}"'; env | grep -c RUNBOOK_VALUE_`,
        `printf '[%s][%s][%s]' {{ .inputs.v }} "$LINENO" "$(printf %s {{ .inputs.v }})"`,
        `printf '[%s]' "$LINENO"`,
      ].join("\n"),
      sources({ v: "x" }),
    )
    // Run as a file, as a block runs its script, so `$LINENO` counts its lines.
    const cwd = nodeFs.mkdtempSync(nodePath.join(folder, "run-"))
    nodeFs.writeFileSync(nodePath.join(cwd, "script.sh"), script)
    const ran = spawnSync("/bin/bash", ["script.sh"], {
      cwd,
      env: { PATH: "/usr/bin:/bin", RUNBOOK_VALUE_1: Redacted.value(env["RUNBOOK_VALUE_1"]!) },
      encoding: "utf8",
    })
    expect(ran.stderr).toBe("")
    expect(ran.stdout).toBe("[unset]0\n[x][2][x][3]")
  })

  it("hold a number or boolean as its text, a list or map as JSON, and a map's key by its path", () => {
    const { env } = inserted(
      "{{ .inputs.n }} {{ .inputs.b }} {{ .inputs.list }} {{ .inputs.tags.env }}",
      sources({ n: 3, b: false, list: ["a", "b"], tags: { env: "prod" } }),
    )
    expect(Object.values(env).map((value) => Redacted.value(value))).toEqual([
      "3",
      "false",
      '["a","b"]',
      "prod",
    ])
  })

  it("are none for a script with no reference, which is left as written whatever runs it", () => {
    const script = "print('{ not a template }')"
    expect(inserted(script, sources(), "python3")).toEqual({ script, env: {} })
  })
})

describe("the rest of a template", () => {
  it("keeps a string constant's text, drops a comment, and trims beside `{{-` and `-}}`", () => {
    const { script } = inserted(
      "docker ps --format '{{`{{.Names}}`}}' {{ \"{{\" }}\n{{/* gone */}}a  {{- .inputs.v -}}  b",
      sources({ v: "x" }),
    )
    expect(script).toBe(
      `export -n RUNBOOK_VALUE_1; docker ps --format '{{.Names}}' {{\na"\${RUNBOOK_VALUE_1}"b`,
    )
  })
})

describe("a template refused, at its line", () => {
  const value = sources({ v: "x" })

  it.each([
    [
      "a heredoc whose delimiter is quoted",
      "cat <<'EOF'\n{{ .inputs.v }}\nEOF",
      "quoted",
      "NAME={{ .inputs.v }}",
    ],
    ["$'...'", "echo $'{{ .inputs.v }}'", "$'...'", "NAME={{ .inputs.v }}"],
    ["backquotes", "echo `echo {{ .inputs.v }}`", "backquotes", "Use `$(...)` instead."],
    ["${...}", 'echo "${X:-{{ .inputs.v }}}"', "${...}", "NAME={{ .inputs.v }}"],
    ["$((...))", "echo $(( {{ .inputs.v }} + 1 ))", "arithmetic", "NAME={{ .inputs.v }}"],
    ["((...))", "(( {{ .inputs.v }} > 1 ))", "arithmetic", "NAME={{ .inputs.v }}"],
    [
      "right after a backslash",
      "echo \\{{ .inputs.v }}",
      "right after a `\\`",
      "NAME={{ .inputs.v }}",
    ],
    [
      "right after a backslash in double quotes",
      'echo "\\{{ .inputs.v }}"',
      "right after a `\\`",
      "NAME={{ .inputs.v }}",
    ],
    [
      "right after a backslash in a heredoc",
      "cat <<EOF\n\\{{ .inputs.v }}\nEOF",
      "right after a `\\`",
      "NAME={{ .inputs.v }}",
    ],
    [
      "right after a backslash in $'...'",
      "echo $'\\{{ .inputs.v }}'",
      "right after a `\\`",
      "NAME={{ .inputs.v }}",
    ],
    [
      "right after a backslash in backquotes",
      "echo `echo \\{{ .inputs.v }}`",
      "right after a `\\`",
      "NAME={{ .inputs.v }}",
    ],
    [
      "right after a backslash in ${...}",
      'echo "${X:-\\{{ .inputs.v }}}"',
      "right after a `\\`",
      "NAME={{ .inputs.v }}",
    ],
    ["right after a $", 'echo "${{ .inputs.v }}"', "right after a `$`", "NAME={{ .inputs.v }}"],
    ["a heredoc's delimiter", "cat <<{{ .inputs.v }}", "delimiter", "NAME={{ .inputs.v }}"],
  ])("a reference in %s", (_, template, why, instead) => {
    const script = `echo first\n${template}`
    const problem = refused(script, value)
    expect(problem.line).toBe(script.slice(0, script.indexOf("{{ .")).split("\n").length)
    expect(problem.message).toContain(why)
    expect(problem.message).toContain(instead)
  })

  it.each([
    ["a condition", "{{ if .inputs.v }}x{{ end }}", [1, 20]],
    ["a pipe", "{{ .inputs.v | upper }}", [1]],
    ["a function", '{{ eq .inputs.v "x" }}', [1]],
    ["text for another tool", "docker ps --format '{{.Names}}'", [21]],
  ])("%s, each action", (_, template, columns) => {
    const problems = refusedAll(`echo first\n${template}`, value)
    expect(problems.map(({ line, column }) => [line, column])).toEqual(
      columns.map((column) => [2, column]),
    )
    for (const { message } of problems)
      expect(message).toContain("is not a value Runbooks can insert")
  })

  it("a reference in a script that does not run with bash", () => {
    const problem = refused("print('{{ .inputs.v }}')", value, "python3")
    expect(problem.message).toContain("This one runs with python3")
  })

  it("a reference to a field no form the block reads has, or an output its block has not given", () => {
    expect(refused("echo {{ .inputs.missing }}", value).message).toContain(
      "names no field of the forms this block reads",
    )
    expect(
      refused("echo {{ .outputs.s.other }}", sources({}, outputs({ s: { k: "y" } }))).message,
    ).toContain("names an output block s has not given")
  })

  it("a `{{` never closed, and a NUL character", () => {
    expect(refused("echo\necho {{ .inputs.v").line).toBe(2)
    expect(refused("echo \u0000").message).toContain("NUL")
  })

  it("a string constant that holds a NUL character, leaving the reference after it its own value", () => {
    const problem = refused('echo {{ "\\u0000" }} {{ .inputs.v }}', value)
    expect(problem).toEqual({
      line: 1,
      column: 6,
      message: expect.stringContaining('`{{ "\\u0000" }}` holds a NUL character'),
    })
  })

  it("a comment with more after it in its action, which would drop the reference", () => {
    expect(refused("echo {{/* x */ .inputs.v }}", value).message).toContain(
      "`{{/* x */ .inputs.v }}` holds more than a comment",
    )
  })
})

describe("a value the environment cannot hold", () => {
  const KIB = 1024

  it("holds a NUL character: refused, naming the reference and never the value", () => {
    const problems = refusedAll(
      "echo {{ .inputs.v }} {{ .outputs.s.k }}",
      sources({ v: "secret-token\u0000rest" }, outputs({ s: { k: "other-secret\u0000" } })),
    )
    expect(problems.map((problem) => problem.message)).toEqual([
      expect.stringContaining("`{{ .inputs.v }}` holds a NUL character"),
      expect.stringContaining("`{{ .outputs.s.k }}` holds a NUL character"),
    ])
    expect(JSON.stringify(problems)).not.toContain("secret")
  })

  it("is over 64 KiB as UTF-8: refused, naming the reference and the limit; 64 KiB runs", () => {
    // "é" is two bytes as UTF-8, so this is 64 KiB in 32 Ki characters.
    const most = "é".repeat(32 * KIB)
    expect(ranWithBash("printf %s {{ .inputs.v }} | wc -c", sources({ v: most })).trim()).toBe(
      String(64 * KIB),
    )
    const problem = refused("echo {{ .inputs.v }}", sources({ v: `${most}a` }))
    expect(problem.message).toContain("`{{ .inputs.v }}` is over 64 KiB")
    expect(problem.message).not.toContain("éé")
  })

  it("brings all the values over 256 KiB: refused at the reference that does; 256 KiB runs", () => {
    const most = "a".repeat(64 * KIB)
    const four = sources({ a: most, b: most, c: most, d: most })
    // A value read twice is one variable, so `.inputs.a` counts once.
    expect(
      ranWithBash(
        "printf %s {{ .inputs.a }}{{ .inputs.b }}{{ .inputs.c }}{{ .inputs.d }}{{ .inputs.a }} | wc -c",
        four,
      ).trim(),
    ).toBe(String(5 * 64 * KIB))
    const problem = refused(
      "echo {{ .inputs.a }} {{ .inputs.b }} {{ .inputs.c }} {{ .inputs.d }} {{ .inputs.e }}",
      sources({ a: most, b: most, c: most, d: most, e: "x" }),
    )
    expect(problem).toEqual({
      line: 1,
      column: 70,
      message: expect.stringContaining(
        "`{{ .inputs.e }}` brings this script's values over 256 KiB",
      ),
    })
  })
})

describe("every problem in a template", () => {
  it("is reported, in order, each at its line and column", () => {
    const problems = refusedAll(
      "echo $'{{ .inputs.v }}'\n  echo {{ .inputs.missing }} {{ if x }}\necho \u0000 {{ .inputs.v",
      sources({ v: "x" }),
    )
    expect(problems.map(({ line, column }) => [line, column])).toEqual([
      [1, 8],
      [2, 8],
      [2, 30],
      [3, 6],
      [3, 8],
    ])
    expect(problems.map(({ message }) => message)).toEqual([
      expect.stringContaining("`$'...'`"),
      expect.stringContaining("names no field"),
      expect.stringContaining("is not a value Runbooks can insert"),
      expect.stringContaining("NUL"),
      expect.stringContaining("not closed"),
    ])
  })

  it("names each reference in a script that does not run with bash", () => {
    const problems = refusedAll(
      "print('{{ .inputs.v }}')\nprint('{{ .inputs.w }}')",
      sources(),
      "python3",
    )
    expect(problems.map(({ line, message }) => [line, message.slice(0, 18)])).toEqual([
      [1, "`{{ .inputs.v }}` "],
      [2, "`{{ .inputs.w }}` "],
    ])
  })
})
