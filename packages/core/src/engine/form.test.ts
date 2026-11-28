import { describe, expect, it } from "bun:test"
import { Redacted, Result } from "effect"
import type { FormSpec } from "@runbooks/blocks-core/form"
import { MAX_NESTING } from "../document/mdx.ts"
import { ToyField, toyFormSpec } from "../test-utils/toyRegistry.ts"
import {
  enter,
  fieldErrors,
  fieldViews,
  makeForm,
  sectionsOf,
  unreviewedOf,
  valuesOf,
} from "./form.ts"

/** The form `spec` makes, which a test expects to have no problems. */
const formOf = (spec: FormSpec) => Result.getOrThrow(makeForm(spec))

/** The problems `makeForm` finds in `spec`, or none. */
const problemsOf = (spec: FormSpec) =>
  Result.match(makeForm(spec), { onSuccess: () => [], onFailure: (problems) => problems })

const field = (name: string, rest: Partial<typeof ToyField.Type> = {}) => ({
  name,
  type: "string" as const,
  ...rest,
})

describe("a form's order", () => {
  it("shows the fields in no section first, then each section's, each in field order", () => {
    const spec: FormSpec = {
      ...toyFormSpec([
        field("memory", { section: "Advanced" }),
        field("name"),
        field("region", { section: "Where" }),
        field("timeout", { section: "Advanced" }),
        field("owner"),
        field("tags", { section: "Labels" }),
        field("zone", { section: "Where" }),
      ]),
      sections: [
        { name: "Where", collapsed: false },
        { name: "Advanced", collapsed: true },
        { name: "Where", collapsed: true },
        { name: "Unused", collapsed: true },
      ],
    }
    const form = formOf(spec)
    expect(fieldViews(form).map((view) => [view.name, view.section])).toEqual([
      ["name", undefined],
      ["owner", undefined],
      ["region", "Where"],
      ["zone", "Where"],
      ["memory", "Advanced"],
      ["timeout", "Advanced"],
      ["tags", "Labels"],
    ])
    // A section listed twice counts where it is first; one no field is in is left out;
    // one a field names that is not listed follows, unfolded.
    expect(sectionsOf(form)).toEqual([
      { name: "Where", collapsed: false },
      { name: "Advanced", collapsed: true },
      { name: "Labels", collapsed: false },
    ])
  })

  it("has no sections when no field is in one", () => {
    const form = formOf({
      ...toyFormSpec([field("name")]),
      sections: [{ name: "Unused", collapsed: true }],
    })
    expect(sectionsOf(form)).toEqual([])
  })
})

describe("a hidden field", () => {
  it("is shown, locked, while it has an error, and is not otherwise", () => {
    const form = formOf(
      toyFormSpec([
        field("token", { hidden: true, required: true }),
        field("account", { hidden: true, default: "123" }),
        field("name"),
      ]),
    )
    expect(fieldErrors(form)).toEqual([["token", "token is required"]])
    expect(fieldViews(form).map((view) => [view.name, view.readOnly, view.reviewed])).toEqual([
      ["token", true, true],
      ["name", false, false],
    ])
    expect(unreviewedOf(form)).toEqual(["name"])
    expect(enter(form, { token: "t", account: "9" }, "agent").rejected).toEqual({
      token: '"token" is read-only.',
      account: 'The form has no field "account".',
    })
  })
})

describe("the values a reader gets", () => {
  it("are what an empty field gives for a field with an error, never the value that failed", () => {
    const form = enter(
      formOf(
        toyFormSpec([
          field("count", { type: "int" }),
          field("region", { validations: [{ kind: "regex", args: ["^[a-z]+-[0-9]$"] }] }),
          field("token", { sensitive: true, validations: [{ kind: "length", args: [8, 64] }] }),
          field("port", { type: "int", default: 8080 }),
          field("name", { default: "web" }),
        ]),
      ),
      { count: "three", region: "Ireland", token: "short", port: "eighty" },
      "person",
    ).form
    expect(fieldErrors(form).map(([name]) => name)).toEqual(["count", "region", "token", "port"])
    const values = Object.fromEntries(
      Array.from(valuesOf(form), ([name, value]) => [name, Redacted.value(value)]),
    )
    // Not even a default: the field holds no valid value until someone changes it.
    expect(values).toEqual({ count: "", region: "", token: "", port: "", name: "web" })
  })
})

describe("a form's problems", () => {
  it("are a default that reads other values, and options from an output, which are not built yet, naming each field", () => {
    const spec = toyFormSpec([
      field("bucket", { default: "{{ .Project }}-state" }),
      field("tags", { type: "list", default: ["fixed", "{{ .Env }}"] }),
      field("labels", { type: "map", default: { "{{ .Team }}": "owner" } }),
      field("plain", { default: "no {braces} here" }),
      field("region", { type: "enum", optionsFrom: { block: "regions", output: "names" } }),
    ])
    expect(problemsOf(spec)).toEqual([
      'The default of the field "bucket" reads other values with {{ }}, which is not built yet: give it a plain value.',
      'The default of the field "tags" reads other values with {{ }}, which is not built yet: give it a plain value.',
      'The default of the field "labels" reads other values with {{ }}, which is not built yet: give it a plain value.',
      'The options of the field "region" come from the output "names" of "regions", which is not built yet: list them in its options.',
    ])
  })

  it("quote none of a default, which may be a secret", () => {
    const spec = toyFormSpec([
      field("token", { sensitive: true, default: "fake-secret-{{ .Seed }}" }),
    ])
    const [problem] = problemsOf(spec)
    expect(problem).toContain('"token"')
    expect(problem).not.toContain("fake-secret")
  })

  it("are a description nested too deep for the window to draw", () => {
    const spec = toyFormSpec([
      field("region", { description: `${"> ".repeat(MAX_NESTING - 1)}x` }),
      field("zone", { description: `${"> ".repeat(MAX_NESTING - 2)}x` }),
    ])
    expect(problemsOf(spec)).toEqual([
      `The description of the field "region" is nested more than ${MAX_NESTING} levels deep. A description may nest its quotes and lists, and the parts inside them, at most ${MAX_NESTING} levels deep.`,
    ])
  })
})
