import { describe, it, expect } from "vitest"
import {
  containsTemplateValue,
  isTemplateValue,
  outputDependenciesIn,
  parseTemplateValue,
  resolvedEntries,
  resolvedItems,
  resolvedValueText,
  summarizeTemplateValue,
} from "./templateValue"

describe("isTemplateValue", () => {
  it.each([
    ["{{ .SecurityModulesVersion }}", true],
    ["aws-sso@{{ .EmailDomainName }}", true],
    ["{{ if .A }}\nx\n{{ end }}", true],
    ["plain text", false],
    ["{ not a template }", false],
    ["", false],
  ])("%j -> %s", (value, expected) => {
    expect(isTemplateValue(value)).toBe(expected)
  })

  it.each([undefined, null, 42, true, ["{{ .A }}"], { a: "{{ .A }}" }])(
    "is false for the non-string %j",
    (value) => {
      expect(isTemplateValue(value)).toBe(false)
    },
  )
})

describe("parseTemplateValue", () => {
  it("reads a whole-value reference as one ref segment", () => {
    expect(parseTemplateValue("{{ .SecurityModulesVersion }}")).toEqual({
      kind: "segments",
      segments: [{ kind: "ref", name: "SecurityModulesVersion" }],
    })
  })

  it("reads an .inputs reference by its variable name", () => {
    expect(parseTemplateValue("{{ .inputs.ProjectName }}")).toEqual({
      kind: "segments",
      segments: [{ kind: "ref", name: "ProjectName" }],
    })
  })

  it("reads a reference with trim markers and no spaces", () => {
    expect(parseTemplateValue("{{- .ProjectName -}}")).toEqual({
      kind: "segments",
      segments: [{ kind: "ref", name: "ProjectName" }],
    })
    expect(parseTemplateValue("{{.ProjectName}}")).toEqual({
      kind: "segments",
      segments: [{ kind: "ref", name: "ProjectName" }],
    })
  })

  it("keeps the literal text around references", () => {
    expect(parseTemplateValue("aws-sso@{{ .EmailDomainName }}")).toEqual({
      kind: "segments",
      segments: [
        { kind: "text", text: "aws-sso@" },
        { kind: "ref", name: "EmailDomainName" },
      ],
    })
    expect(parseTemplateValue("{{ .RepoBaseUrl }}/{{ .InfraModulesRepoName }}")).toEqual({
      kind: "segments",
      segments: [
        { kind: "ref", name: "RepoBaseUrl" },
        { kind: "text", text: "/" },
        { kind: "ref", name: "InfraModulesRepoName" },
      ],
    })
  })

  it("drops the whitespace a trim marker removes, as the rendered value does", () => {
    expect(parseTemplateValue("prefix  {{- .A }} - {{ .B -}}  suffix")).toEqual({
      kind: "segments",
      segments: [
        { kind: "text", text: "prefix" },
        { kind: "ref", name: "A" },
        { kind: "text", text: " - " },
        { kind: "ref", name: "B" },
        { kind: "text", text: "suffix" },
      ],
    })
  })

  it("reads a conditional as computed, ignoring words inside string literals", () => {
    expect(parseTemplateValue('{{ if eq .SCMProvider "GitHub" }}v4{{ else }}v1{{ end }}')).toEqual({
      kind: "computed",
      refs: ["SCMProvider"],
    })
    expect(
      parseTemplateValue(
        '{{ if eq .Host "github.com" }}a{{ else if eq .Host `gitlab.com` }}b{{ end }}',
      ),
    ).toEqual({
      kind: "computed",
      refs: ["Host"],
    })
    // A literal whose text starts with a dot, or has one after a space, looks
    // like a field reference unless the literal is skipped.
    expect(parseTemplateValue('{{ if eq .Env ".prod" }}a{{ end }}')).toEqual({
      kind: "computed",
      refs: ["Env"],
    })
    expect(parseTemplateValue('{{ printf "see .Docs" .A }}')).toEqual({
      kind: "computed",
      refs: ["A"],
    })
    expect(parseTemplateValue("{{ printf `x .Raw` .A }}")).toEqual({
      kind: "computed",
      refs: ["A"],
    })
  })

  it("reads a pipeline or function call as computed, with each variable it uses once", () => {
    expect(parseTemplateValue("{{ .ProjectName | lower }}")).toEqual({
      kind: "computed",
      refs: ["ProjectName"],
    })
    expect(parseTemplateValue('{{ printf "%s-%s" .inputs.A .B }}-{{ .A | upper }}')).toEqual({
      kind: "computed",
      refs: ["A", "B"],
    })
  })

  it("names only the variable, not the field, of a nested reference", () => {
    expect(parseTemplateValue("{{ .Config.Region }}")).toEqual({
      kind: "computed",
      refs: ["Config"],
    })
  })

  it("reads block outputs and loop values as computed with no refs", () => {
    expect(parseTemplateValue("{{ .outputs.create_account.account_id }}")).toEqual({
      kind: "computed",
      refs: [],
    })
    expect(parseTemplateValue("{{ .__each__ }}")).toEqual({ kind: "computed", refs: [] })
    expect(parseTemplateValue("{{ $x := 1 }}{{ $x.Name }}")).toEqual({ kind: "computed", refs: [] })
  })
})

describe("summarizeTemplateValue", () => {
  it('says "Same as" for a whole-value reference', () => {
    expect(summarizeTemplateValue("{{ .SecurityModulesVersion }}")).toBe(
      "Same as Security Modules Version",
    )
  })

  it('says "Based on" for a composed value or a computed one', () => {
    expect(summarizeTemplateValue("{{ .RepoBaseUrl }}/{{ .InfraModulesRepoName }}")).toBe(
      "Based on Repo Base URL, Infra Modules Repo Name",
    )
    expect(summarizeTemplateValue('{{ if eq .SCMProvider "GitHub" }}v4{{ else }}v1{{ end }}')).toBe(
      "Based on SCM Provider",
    )
  })

  it('says "Set automatically" when it names no variable', () => {
    expect(summarizeTemplateValue("{{ .outputs.create_account.account_id }}")).toBe(
      "Set automatically",
    )
    expect(summarizeTemplateValue("{{ now }}")).toBe("Set automatically")
  })
})

describe("containsTemplateValue", () => {
  it.each([
    ["{{ .A }}", true],
    [["x", "{{ .A }}"], true],
    [{ "{{ .A }}:Team": "DevOps" }, true],
    [{ Owner: "{{ .A }}" }, true],
    [{ security: { email: "x@{{ .Domain }}" } }, true],
    ["plain", false],
    [["x", "y"], false],
    [{ a: "b" }, false],
    [42, false],
    [null, false],
  ])("%j -> %s", (value, expected) => {
    expect(containsTemplateValue(value)).toBe(expected)
  })
})

describe("resolvedValueText", () => {
  it("is the text a value came to", () => {
    expect(resolvedValueText("acme-state")).toBe("acme-state")
  })

  it.each([undefined, null, "", "{{ .outputs.a.b }}", 42, ["x"]])(
    "is undefined for %j, which keeps the tokens",
    (resolved) => {
      expect(resolvedValueText(resolved)).toBeUndefined()
    },
  )
})

describe("resolvedItems", () => {
  it("lines up a resolved list with the list", () => {
    expect(resolvedItems(["a", "{{ .B }}"], ["a", "b"])).toEqual(["a", "b"])
  })

  it.each([undefined, ["a"], { 0: "a", 1: "b" }])("is empty for %j", (resolved) => {
    expect(resolvedItems(["a", "{{ .B }}"], resolved)).toEqual([])
  })
})

describe("resolvedEntries", () => {
  const entries: Array<[string, unknown]> = [
    ["{{ .Org }}:Team", "DevOps"],
    ["Owner", "{{ .Email }}"],
  ]

  it("lines up a resolved map with the map's entries", () => {
    expect(resolvedEntries(entries, { "acme:Team": "DevOps", Owner: "ops@acme.io" })).toEqual([
      ["acme:Team", "DevOps"],
      ["Owner", "ops@acme.io"],
    ])
  })

  it("is empty when two keys came to the same text", () => {
    expect(
      resolvedEntries(
        [
          ["{{ .A }}", "1"],
          ["x", "2"],
        ],
        { x: "2" },
      ),
    ).toEqual([])
  })

  it("is empty when a key came to a number-like text, which moves it first", () => {
    expect(
      resolvedEntries(
        [
          ["Name", "a"],
          ["{{ .Id }}", "b"],
        ],
        { Name: "a", "7": "b" },
      ),
    ).toEqual([])
  })

  it.each([undefined, ["DevOps"], "x"])("is empty for %j", (resolved) => {
    expect(resolvedEntries(entries, resolved)).toEqual([])
  })
})

describe("outputDependenciesIn", () => {
  it("finds outputs used anywhere in a value, once each", () => {
    const value = {
      "{{ .outputs.make_account.region }}:Team": "{{ .outputs.make_account.account_id }}",
      Owners: ["ops", "{{ .outputs.make-account.account_id }}", "{{ .outputs.iam.role }}"],
    }

    expect(outputDependenciesIn(value).map((d) => `${d.blockId}.${d.outputName}`)).toEqual([
      "make_account.region",
      "make_account.account_id",
      "iam.role",
    ])
  })

  it.each(["plain", "{{ .ProjectName }}-state", ["a", "b"], { a: "b" }, 42])(
    "is empty for %j",
    (value) => {
      expect(outputDependenciesIn(value)).toEqual([])
    },
  )
})
