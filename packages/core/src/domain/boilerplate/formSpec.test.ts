import { describe, expect, it } from "bun:test"
import path from "node:path"
import { Result } from "effect"
import { type Field, MAX_VALUE_DEPTH } from "@runbooks/blocks-core/form"
import { parseYaml, yamlData } from "../../document/yamlData.ts"
import {
  boilerplateFileIn,
  joinedPath,
  prefilledProblems,
  readBoilerplateFile,
  readBoilerplateForm,
  withPrefilled,
} from "./formSpec.ts"

/** The data `yaml` holds. */
const data = (yaml: string): unknown => {
  const { doc } = parseYaml(yaml)
  return Result.getOrThrow(yamlData(doc))
}

const read = (yaml: string) => readBoilerplateForm(data(yaml))

/** A field as the reader gives one with nothing but a name and a type set. */
const plain = (name: string, type: Field["type"] = "string"): Field => ({
  name,
  type,
  description: "",
  required: false,
  validations: [],
  sensitive: false,
  locked: false,
  hidden: false,
})

describe("a boilerplate config's form", () => {
  it("reads each setting of a field", () => {
    const { spec, problems } = read(
      [
        "variables:",
        "  - name: Region",
        "    type: Enum",
        "    description: Where to **deploy**",
        "    default: us-east-1",
        "    options:",
        "      - us-east-1",
        "      - { value: eu-west-1, label: Ireland }",
        "    sensitive: true",
        "    x-section: Where",
        "    x-locked: true",
        "    x-hidden: false",
        "    x-show-when: { Mode: [custom, other], Count: 3 }",
        "    validations:",
        "      - required",
        "      - type: Regex",
        "        regex: ^[a-z-0-9]+$",
        "        description: lowercase",
        "      - { type: length, args: [1, 20], message: short }",
        "      - { type: length, min: 2, max: 9 }",
        "  - name: Tags",
        "    type: list",
        "    x-options: [web, db]",
        "  - name: Accounts",
        "    type: map",
        "    x-schema: { email: string, id: Int, weird: nope }",
        "    x-schema-instance-label: Account name",
        "  - name: Mode",
        "    type: enum",
        "    options: [custom, other]",
        "  - name: Count",
        "    type: int",
      ].join("\n"),
    )
    expect(problems).toEqual([])
    expect(spec.fields).toEqual([
      {
        ...plain("Region", "enum"),
        description: "Where to **deploy**",
        default: "us-east-1",
        options: ["us-east-1", "eu-west-1"],
        optionLabels: { "us-east-1": "us-east-1", "eu-west-1": "Ireland" },
        sensitive: true,
        section: "Where",
        locked: true,
        showWhen: { Mode: ["custom", "other"], Count: ["3"] },
        required: true,
        validations: [
          { kind: "required" },
          { kind: "regex", message: "lowercase", args: ["^[a-z-0-9]+$"] },
          { kind: "length", message: "short", args: [1, 20] },
          { kind: "length", args: [2, 9] },
        ],
      },
      { ...plain("Tags", "list"), options: ["web", "db"] },
      {
        ...plain("Accounts", "map"),
        // A type it doesn't know is text, as a field's is.
        schema: { email: "string", id: "int", weird: "string" },
        schemaInstanceLabel: "Account name",
      },
      { ...plain("Mode", "enum"), options: ["custom", "other"] },
      plain("Count", "int"),
    ])
    expect(spec.sections).toEqual([{ name: "Where", collapsed: false }])
  })

  it("takes leniently what the docs say it takes: any type, and any validation", () => {
    const { spec, problems } = read(
      [
        "dependencies: [ignored]",
        "variables:",
        "  - name: NoType",
        "  - name: Odd",
        "    type: Decimal",
        "  - name: 7",
        "    type: bool",
        "    description: 42",
        "  - name: Size",
        "    type: enum",
        "    options: [1, true, small]",
        '    validations: [Email, digit, "length(1,5)", { message: none }, { type: Weird }]',
        "  - name: Plain",
        "    type: list",
        "    x-options: []",
      ].join("\n"),
    )
    expect(problems).toEqual([])
    expect(spec.fields).toEqual([
      plain("NoType"),
      plain("Odd"),
      { ...plain("7", "bool"), description: "42" },
      {
        ...plain("Size", "enum"),
        options: ["1", "true", "small"],
        validations: [
          { kind: "email" },
          { kind: "digit" },
          // A name with arguments is no validation it knows, so it is never checked, as the docs say.
          { kind: "custom" },
          { kind: "custom", message: "none" },
          { kind: "custom" },
        ],
      },
      plain("Plain", "list"),
    ])
    // A config with no variables, as a template's may be, is a form with no fields.
    for (const config of ["", "dependencies: []", "variables:", "variables: []"])
      expect(read(config)).toEqual({ spec: { fields: [], sections: [] }, problems: [] })
  })

  it("finds a config that isn't a map, variables that aren't a list, and a variable with no name", () => {
    const problems = (yaml: string) => read(yaml).problems
    expect(problems("- a list")).toEqual([
      {
        path: [],
        message: "a boilerplate config must be a map of its settings, such as `variables`",
      },
    ])
    for (const yaml of ["variables: none", "variables: { a: 1 }"])
      expect(problems(yaml)).toEqual([
        {
          path: ["variables"],
          message: "`variables` must be a list of variables, each with a `name`",
        },
      ])
    expect(
      problems(
        "variables:\n  - type: string\n  - just text\n  - name: ''\n  - name: [a]\n  - name: ok",
      ),
    ).toEqual(
      [0, 1, 2, 3].map((index) => ({
        path: ["variables", index],
        message: "each variable in `variables` needs a `name`, its text",
      })),
    )
  })

  it("takes options from a block's output, which the engine refuses as not built yet", () => {
    const { spec, problems } = read(
      [
        "variables:",
        "  - name: Region",
        "    type: enum",
        '    options: "{{ fromJson .outputs.list_regions.regions }}"',
        "  - name: Zones",
        "    type: list",
        '    x-options: "{{ .outputs.zones.names }}"',
      ].join("\n"),
    )
    expect(problems).toEqual([])
    expect(spec.fields.map((field) => [field.name, field.optionsFrom])).toEqual([
      ["Region", { block: "list_regions", output: "regions" }],
      ["Zones", { block: "zones", output: "names" }],
    ])
  })

  it("orders the fields by `order`, lowest first, each order keeping the config's order", () => {
    const { spec } = read(
      [
        "variables:",
        "  - { name: c, order: 2 }",
        "  - { name: a }",
        "  - { name: d, order: -1 }",
        "  - { name: b, order: 0 }",
        "  - { name: e, order: 2 }",
      ].join("\n"),
    )
    expect(spec.fields.map((field) => field.name)).toEqual(["d", "a", "b", "c", "e"])
  })

  it("gives the sections in the order of their first field, each folded as `x-sections` says", () => {
    const { spec, problems } = read(
      [
        "x-sections:",
        "  - { name: Advanced, collapsed: true }",
        "  - { name: Where }",
        "  - { name: Where, collapsed: true }",
        "variables:",
        "  - { name: region, x-section: Where }",
        "  - { name: memory, x-section: Advanced }",
        "  - { name: name }",
        "  - { name: first, x-section: Advanced, order: -1 }",
      ].join("\n"),
    )
    expect(problems).toEqual([])
    // A section listed twice takes its last settings, as today.
    expect(spec.sections).toEqual([
      { name: "Advanced", collapsed: true },
      { name: "Where", collapsed: true },
    ])
  })

  it("finds each malformed setting, at its path, naming the field (H2)", () => {
    const { problems } = read(
      [
        "x-sections:",
        "  - { name: Where }",
        "  - { name: Nowhere }",
        "  - { name: Where, collapsed: yes }",
        "  - { collapsed: true }",
        "  - just text",
        "variables:",
        "  - name: region",
        "    x-section: Where",
        "    order: 1.5",
        "    x-locked: yes",
        "    x-hidden: 1",
        "    sensitive: maybe",
        "    x-show-when: Mode",
        "  - name: region",
        "    description: [a, list]",
        "    x-section: { a: 1 }",
        "    x-schema: [email]",
        "    x-schema-instance-label: [x]",
        "  - name: size",
        "    type: enum",
        "    options: [small, [nested], { label: no value }]",
        "    validations: required",
        "  - name: tags",
        "    type: list",
        "    x-options: not a reference",
        "    validations: [required, 3]",
        `    default: ${"[".repeat(MAX_VALUE_DEPTH + 1)}x${"]".repeat(MAX_VALUE_DEPTH + 1)}`,
      ].join("\n"),
    )
    expect(problems).toEqual([
      {
        path: ["variables", 0, "order"],
        message: 'the `order` of the field "region" must be a whole number, such as 2',
      },
      {
        path: ["variables", 0, "sensitive"],
        message: '`sensitive` on the field "region" must be true or false',
      },
      {
        path: ["variables", 0, "x-locked"],
        message: '`x-locked` on the field "region" must be true or false',
      },
      {
        path: ["variables", 0, "x-hidden"],
        message: '`x-hidden` on the field "region" must be true or false',
      },
      {
        path: ["variables", 0, "x-show-when"],
        message: 'on the field "region", x-show-when must map variable names to values',
      },
      {
        path: ["variables", 1, "name"],
        message: 'two fields are named "region": each field needs a name of its own',
      },
      {
        path: ["variables", 1, "description"],
        message: 'the `description` of the field "region" must be text',
      },
      {
        path: ["variables", 1, "x-schema"],
        message:
          'the `x-schema` of the field "region" must map each key to its type, such as { email: string }',
      },
      {
        path: ["variables", 1, "x-schema-instance-label"],
        message: 'the `x-schema-instance-label` of the field "region" must be text',
      },
      {
        path: ["variables", 1, "x-section"],
        message: 'the `x-section` of the field "region" must be text',
      },
      {
        path: ["variables", 2, "options", 1],
        message:
          'each of the `options` of the field "size" must be text, or a map with a `value` and a `label`',
      },
      {
        path: ["variables", 2, "options", 2],
        message:
          'each of the `options` of the field "size" must be text, or a map with a `value` and a `label`',
      },
      {
        path: ["variables", 2, "validations"],
        message: 'the `validations` of the field "size" must be a list',
      },
      {
        path: ["variables", 3, "default"],
        message: `the default of the field "tags" must be text, a number, true or false, or a list or map of them, nested at most ${MAX_VALUE_DEPTH} levels deep`,
      },
      {
        path: ["variables", 3, "x-options"],
        message:
          'the `x-options` of the field "tags" must be a list, or a block\'s output that holds one, such as "{{ fromJson .outputs.<block_id>.<output_name> }}"',
      },
      {
        path: ["variables", 3, "validations", 1],
        message:
          'each validation of the field "tags" must be a name, such as required, or a map with a `type`',
      },
      {
        path: ["x-sections", 1, "name"],
        message: '`x-sections` names the section "Nowhere", which no field is in',
      },
      {
        path: ["x-sections", 2, "collapsed"],
        message: '`collapsed` on the section "Where" must be true or false',
      },
      {
        path: ["x-sections", 3],
        message: "each section in `x-sections` needs a `name`, its text",
      },
      {
        path: ["x-sections", 4],
        message: "each section in `x-sections` needs a `name`, its text",
      },
    ])
    expect(read("x-sections: Where\nvariables: [{ name: a }]").problems).toEqual([
      {
        path: ["x-sections"],
        message: "`x-sections` must be a list of sections, each with a `name`",
      },
    ])
  })

  it("finds each `x-show-when` that names no field, a value no option has, or a cycle, at the field", () => {
    const { problems } = read(
      [
        "variables:",
        "  - { name: Layout, type: enum, options: [single, caf] }",
        "  - { name: Identity, x-show-when: { Layuot: caf } }",
        "  - { name: Network, x-show-when: { Layout: [caf, CAF] } }",
        "  - { name: A, x-show-when: { B: x } }",
        "  - { name: B, x-show-when: { A: x } }",
      ].join("\n"),
    )
    expect(problems).toEqual([
      {
        path: ["variables", 1, "x-show-when", "Layuot"],
        message: 'the `x-show-when` of the field "Identity" names "Layuot", which is no field here',
      },
      {
        path: ["variables", 2, "x-show-when", "Layout"],
        message:
          'the `x-show-when` of the field "Network" gives "Layout" the value "CAF", which is not one of its options (single, caf)',
      },
      {
        path: ["variables", 3, "x-show-when"],
        message:
          "the `x-show-when` conditions of these fields depend on each other in a cycle: A → B → A",
      },
    ])
  })
})

describe("prefilled values", () => {
  const { spec } = read(
    "variables:\n  - { name: Region, default: us-east-1 }\n  - { name: Count, type: int }",
  )

  it("are each field's default, which a field without one gets too", () => {
    expect(withPrefilled(spec, { Region: "eu-west-1", Count: 3 }).fields).toEqual([
      { ...plain("Region"), default: "eu-west-1" },
      { ...plain("Count", "int"), default: 3 },
    ])
    expect(withPrefilled(spec, undefined)).toBe(spec)
  })

  it("name only fields the form has, a near name suggested", () => {
    expect(prefilledProblems(spec, { Regoin: "x", Count: 1, Other: 2 })).toEqual([
      {
        path: ["prefilledVariables", "Regoin"],
        message: '"Regoin" is no field of the form (did you mean "Region"?)',
      },
      { path: ["prefilledVariables", "Other"], message: '"Other" is no field of the form' },
    ])
    expect(prefilledProblems(spec, undefined)).toEqual([])
  })
})

describe("a boilerplate file", () => {
  it("is the file a path names, or else the folder's boilerplate.yml, then its boilerplate.yaml", () => {
    const files = new Map([
      ["vars.yml", "a"],
      ["both/boilerplate.yml", "yml"],
      ["both/boilerplate.yaml", "yaml"],
      ["yaml/boilerplate.yaml", "only yaml"],
      ["none/other.yml", "x"],
    ])
    expect(boilerplateFileIn(files, "vars.yml")).toEqual({ file: "vars.yml", text: "a" })
    expect(boilerplateFileIn(files, "both")).toEqual({ file: "both/boilerplate.yml", text: "yml" })
    expect(boilerplateFileIn(files, "yaml")).toEqual({
      file: "yaml/boilerplate.yaml",
      text: "only yaml",
    })
    expect(boilerplateFileIn(files, "none")).toBeUndefined()
  })

  it("is in its folder as path.posix.join puts it, as the files a block names are keyed", () => {
    const folders = [
      "vpc",
      "vpc/",
      "./vpc",
      ".",
      "./",
      "a/../vpc",
      "a//b/./c",
      "../up",
      "a/../..",
      "/abs",
      "/",
    ]
    for (const folder of folders)
      expect([folder, joinedPath(folder, "boilerplate.yml")]).toEqual([
        folder,
        path.posix.join(folder, "boilerplate.yml"),
      ])
    expect(joinedPath("a", "..")).toBe(path.posix.join("a", ".."))
  })

  it("gives its form, or each problem at its line, quoting none of the file", () => {
    expect(readBoilerplateFile("t/boilerplate.yml", "variables:\n  - name: a\n")).toEqual(
      Result.succeed({ fields: [plain("a")], sections: [] }),
    )
    const secret = "fake-secret-91ab"
    expect(
      readBoilerplateFile(
        "t/boilerplate.yml",
        `variables:\n  - name: a\n    default: ${secret}\n    default: again\n`,
      ),
    ).toEqual(
      Result.fail([
        "t/boilerplate.yml isn't valid YAML at line 4, column 5: a key appears twice in one map.",
      ]),
    )
    expect(
      readBoilerplateFile(
        "t/boilerplate.yml",
        `variables:\n  - name: a\n    default: ${secret}\n    order: x\n  - name: a\n`,
      ),
    ).toEqual(
      Result.fail([
        't/boilerplate.yml, line 4: the `order` of the field "a" must be a whole number, such as 2.',
        't/boilerplate.yml, line 5: two fields are named "a": each field needs a name of its own.',
      ]),
    )
    expect(readBoilerplateFile("t/boilerplate.yml", "loop: &l [*l]\n")).toEqual(
      Result.fail([
        "t/boilerplate.yml can't be read at line 1: An alias names a node that holds it, so the data would hold itself.",
      ]),
    )
  })
})
