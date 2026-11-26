import { describe, expect, it } from "bun:test"
import { Redacted, Result, Schema } from "effect"
import { BlockId, type BlockOutputs } from "@runbooks/blocks-core/contract"
import type { FormValues } from "@runbooks/blocks-core/form"
import { renderValueTemplate, type ValueSources } from "./valueTemplate.ts"

const blockId = Schema.decodeSync(BlockId)

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

const rendered = (template: string, from: ValueSources = sources()): string => {
  const result = renderValueTemplate(template, from)
  if (Result.isFailure(result)) throw new Error(result.failure.message)
  return Redacted.value(result.success)
}

const refused = (template: string, from: ValueSources = sources()) => {
  const result = renderValueTemplate(template, from)
  if (Result.isSuccess(result)) throw new Error(`rendered: ${Redacted.value(result.success)}`)
  return result.failure
}

describe("a value template", () => {
  it("fills in each reference with its value's text, the rest as written", () => {
    const from = sources(
      { region: "eu-west-1", n: 3, on: false, list: ["a", "b"], tags: { env: "prod" } },
      outputs({ "make-it": { k: "it's $(x)" } }),
    )
    expect(
      rendered(
        "{{ .inputs.region }}/{{.inputs.n}}/{{ .inputs.on }}/{{ .inputs.list }}/{{ .inputs.tags.env }}/{{ .outputs.make-it.k }}",
        from,
      ),
    ).toBe(`eu-west-1/3/false/["a","b"]/prod/it's $(x)`)
  })

  it("is held redacted", () => {
    const result = renderValueTemplate("{{ .inputs.v }}", sources({ v: "x" }))
    expect(Result.isSuccess(result) && Redacted.isRedacted(result.success)).toBe(true)
  })

  it("keeps a string constant's text, drops a comment, and trims beside `{{-` and `-}}`", () => {
    expect(
      rendered(
        '--format {{`{{.Names}}`}} {{ "{{" }} {{ "}}" }}\n{{/* gone */}}a  {{- .inputs.v -}}  b',
        sources({ v: "x" }),
      ),
    ).toBe("--format {{.Names}} {{ }}\naxb")
  })

  it("leaves text with no `{{` as written", () => {
    expect(rendered("plain } { text")).toBe("plain } { text")
  })
})

describe("a value template refused, where its problem starts", () => {
  it.each([
    ["a condition", "x {{ if .inputs.v }}y{{ end }}"],
    ["a pipe", "x {{ .inputs.v | upper }}"],
    ["a function", 'x {{ eq .inputs.v "y" }}'],
    ["text for another tool", "x {{.Names}}"],
  ])("%s", (_, template) => {
    const problem = refused(template, sources({ v: "y" }))
    expect(problem.at).toBe(2)
    expect(problem.message).toContain("is not a value Runbooks can insert")
  })

  it("shows the action it refuses without its string constants, which may be secrets", () => {
    const { message } = refused("x {{ printf \"%s\" `fake-secret-7f3a` 'k' }}")
    expect(message).toStartWith("`{{ printf \"…\" `…` '…' }}` is not a value")
    expect(message).not.toContain("fake-secret-7f3a")
  })

  it("another tool's `{{ }}`, saying how to write `{{` as text", () => {
    expect(refused("x {{.Names}}").message).toContain('To write `{{` as text, write `{{ "{{" }}`.')
  })

  it("a name an object has but no form gives, such as `constructor`", () => {
    expect(refused("{{ .inputs.constructor }}", sources({ v: "y" })).message).toContain(
      "names no field",
    )
    expect(
      refused("{{ .inputs.tags.constructor }}", sources({ tags: { env: "prod" } })).message,
    ).toContain("names no field")
  })

  it("a `{{` never closed, even by a `}}` inside a string constant", () => {
    expect(refused('x {{ "}}"')).toEqual({ at: 2, message: "A `{{` is not closed with `}}`." })
    expect(refused("x {{ .inputs.v").at).toBe(2)
  })

  it("a field no form the block reads has, or an output its block has not given", () => {
    expect(refused("x {{ .inputs.missing }}", sources({ v: "y" }))).toEqual({
      at: 2,
      message:
        "`{{ .inputs.missing }}` names no field of the forms this block reads (its `inputsId` forms and its own).",
    })
    expect(
      refused("{{ .inputs.tags.nope }}", sources({ tags: { env: "prod" } })).message,
    ).toContain("names no field")
    expect(refused("{{ .outputs.s.other }}", sources({}, outputs({ s: { k: "y" } })))).toEqual({
      at: 0,
      message: "`{{ .outputs.s.other }}` names an output block s has not given.",
    })
  })
})
