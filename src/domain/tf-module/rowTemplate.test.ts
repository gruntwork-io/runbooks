import { describe, it, expect } from "bun:test"
import { renderRowTemplate, rowTemplateError, templateFields } from "./rowTemplate.ts"

describe("renderRowTemplate", () => {
  const label = "{{ .domainName }}{{ if .isPrimary }} (primary){{ end }}"

  it("fills fields and picks a branch", () => {
    expect(renderRowTemplate(label, { domainName: "example.com", isPrimary: true })).toBe(
      "example.com (primary)",
    )
    expect(renderRowTemplate(label, { domainName: "example.org", isPrimary: false })).toBe(
      "example.org",
    )
  })

  it("takes the else branch", () => {
    expect(
      renderRowTemplate("{{ if .name }}{{ .name }}{{ else }}{{ .email }}{{ end }}", {
        email: "a@b.c",
      }),
    ).toBe("a@b.c")
  })

  it("writes a missing field as nothing", () => {
    expect(renderRowTemplate("<{{ .nope }}>", {})).toBe("<>")
  })

  it("refuses syntax it doesn't support, rather than rendering it wrong", () => {
    expect(rowTemplateError("{{ .a | upper }}")).toContain("isn't supported")
    expect(rowTemplateError("{{ if .a }}{{ if .b }}{{ end }}{{ end }}")).toContain("Nested")
    expect(rowTemplateError("{{ if .a }}")).toContain("without")
    expect(rowTemplateError(label)).toBeUndefined()
  })
})

describe("templateFields", () => {
  it("lists the fields a template reads, once each", () => {
    expect(templateFields("{{ .a }}@{{ if .b }}{{ .a }}{{ end }}")).toEqual(["a", "b"])
  })
})
