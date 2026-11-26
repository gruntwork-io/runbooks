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
    throw new Error(`line ${result.failure.line}: ${result.failure.message}`)
  return result.success
}

const refused = (template: string, from: ValueSources = sources(), interpreter = "bash") => {
  const result = insertValues(template, from, interpreter)
  if (Result.isSuccess(result)) throw new Error(`inserted: ${result.success.script}`)
  return result.failure
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

  it("in a heredoc whose delimiter is not quoted, as `<<` and `<<-` write it", () => {
    expect(ranWithBash("cat <<EOF\nbefore {{ .inputs.v }} after\nEOF\n", value)).toBe(
      `before ${HOSTILE} after\n`,
    )
    expect(ranWithBash("cat <<-EOF\n\tbefore {{ .inputs.v }} after\n\tEOF\n", value)).toBe(
      `before ${HOSTILE} after\n`,
    )
  })

  it("in a comment, which stays one", () => {
    expect(ranWithBash("# {{ .inputs.v }}\nprintf done", value)).toBe("done")
  })

  it("in $(...) inside double quotes, as a word of the commands there", () => {
    expect(ranWithBash("printf '%s' \"$(printf '<%s>' {{ .inputs.v }})\"", value)).toBe(
      `<${HOSTILE}>`,
    )
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
})

describe("the variables", () => {
  it("are one per value, however often the script reads it, and hold it redacted", () => {
    const { script, env } = inserted(
      "a={{ .inputs.v }}; b=\"{{ .inputs.v }}\"; c='{{ .outputs.s.k }}'",
      sources({ v: "x" }, outputs({ s: { k: "y" } })),
    )
    expect(script).toBe(
      `a="\${RUNBOOK_VALUE_1}"; b="\${RUNBOOK_VALUE_1}"; c=''"\${RUNBOOK_VALUE_2}"''`,
    )
    expect(Object.keys(env)).toEqual(["RUNBOOK_VALUE_1", "RUNBOOK_VALUE_2"])
    expect(Redacted.isRedacted(env["RUNBOOK_VALUE_1"])).toBe(true)
    expect(Redacted.value(env["RUNBOOK_VALUE_2"]!)).toBe("y")
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
    expect(script).toBe(`docker ps --format '{{.Names}}' {{\na"\${RUNBOOK_VALUE_1}"b`)
  })
})

describe("a template refused, at its line", () => {
  const value = sources({ v: "x" })

  it.each([
    ["a heredoc whose delimiter is quoted", "cat <<'EOF'\n{{ .inputs.v }}\nEOF", "quoted"],
    ["$'...'", "echo $'{{ .inputs.v }}'", "$'...'"],
    ["backquotes", "echo `echo {{ .inputs.v }}`", "backquotes"],
    ["${...}", 'echo "${X:-{{ .inputs.v }}}"', "${...}"],
    ["$((...))", "echo $(( {{ .inputs.v }} + 1 ))", "arithmetic"],
    ["((...))", "(( {{ .inputs.v }} > 1 ))", "arithmetic"],
    ["right after a backslash", "echo \\{{ .inputs.v }}", "right after a `\\`"],
    ["right after a $", 'echo "${{ .inputs.v }}"', "right after a `$`"],
    ["a heredoc's delimiter", "cat <<{{ .inputs.v }}", "delimiter"],
  ])("a reference in %s", (_, template, why) => {
    const script = `echo first\n${template}`
    const problem = refused(script, value)
    expect(problem.line).toBe(script.slice(0, script.indexOf("{{ .")).split("\n").length)
    expect(problem.message).toContain(why)
    expect(problem.message).toContain("NAME={{ .inputs.v }}")
  })

  it.each([
    ["a condition", "{{ if .inputs.v }}x{{ end }}"],
    ["a pipe", "{{ .inputs.v | upper }}"],
    ["a function", '{{ eq .inputs.v "x" }}'],
    ["text for another tool", "docker ps --format '{{.Names}}'"],
  ])("%s", (_, template) => {
    const problem = refused(`echo first\n${template}`, value)
    expect(problem.line).toBe(2)
    expect(problem.message).toContain("is not a value Runbooks can insert")
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
})
