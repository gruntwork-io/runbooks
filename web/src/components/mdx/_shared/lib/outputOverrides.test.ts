import { describe, it, expect } from "vitest"
import { isSensitiveOutput, revealOutput, sensitiveOutput } from "@/lib/outputValues"
import {
  applyOverrides,
  envValueParts,
  isOverridden,
  outputRef,
  overrideFor,
  overridesFor,
  withOverride,
} from "./outputOverrides"

describe("envValueParts", () => {
  it("makes a plain output reference its one part", () => {
    expect(envValueParts("{{ .outputs.fetch_pr.title }}")).toEqual([
      {
        kind: "output",
        ref: { blockId: "fetch_pr", outputName: "title", fullPath: "outputs.fetch_pr.title" },
      },
    ])
  })

  it("keeps the text around output references, in order", () => {
    expect(envValueParts("s3://{{.outputs.a.bucket}}/{{ .outputs.b.key }}.json")).toEqual([
      { kind: "text", text: "s3://" },
      { kind: "output", ref: outputRef("a", "bucket") },
      { kind: "text", text: "/" },
      { kind: "output", ref: outputRef("b", "key") },
      { kind: "text", text: ".json" },
    ])
  })

  it("keeps a block id as written and normalizes it in the full path", () => {
    const [part] = envValueParts("{{ .outputs.create-account.account_id }}")!
    expect(part).toEqual({
      kind: "output",
      ref: {
        blockId: "create-account",
        outputName: "account_id",
        fullPath: "outputs.create_account.account_id",
      },
    })
  })

  it("drops the whitespace trim markers remove", () => {
    expect(envValueParts("a  {{- .outputs.x.y -}}  b")).toEqual([
      { kind: "text", text: "a" },
      { kind: "output", ref: outputRef("x", "y") },
      { kind: "text", text: "b" },
    ])
  })

  it.each([
    ["an input", "{{ .inputs.Prefix }}-{{ .outputs.a.b }}"],
    ["a pipe", "{{ .outputs.a.b | upper }}"],
    ["a guard", '{{ if hasKey .outputs.a "b" }}{{ .outputs.a.b }}{{ end }}'],
    ["a comment", "{{/* note */}}{{ .outputs.a.b }}"],
  ])("is null for a value with %s", (_, value) => {
    expect(envValueParts(value)).toBeNull()
  })

  it.each([["plain text"], [""], ["{{ .inputs.Region }}"]])(
    "is null for %j, which reads no output",
    (value) => {
      expect(envValueParts(value)).toBeNull()
    },
  )
})

describe("overrides", () => {
  const title = outputRef("fetch-pr", "title")
  const body = outputRef("fetch_pr", "body")
  const tag = outputRef("build", "tag")

  it("sets, reads and removes a value by the normalized block id", () => {
    let overrides = withOverride({}, title, "Fix it")
    overrides = withOverride(overrides, body, "Details")
    expect(overrides).toEqual({ fetch_pr: { title: "Fix it", body: "Details" } })
    expect(overrideFor(overrides, title)).toBe("Fix it")
    expect(isOverridden(overrides, title.fullPath)).toBe(true)

    overrides = withOverride(overrides, title, undefined)
    expect(overrides).toEqual({ fetch_pr: { body: "Details" } })
    expect(overrideFor(overrides, title)).toBeUndefined()
    expect(isOverridden(overrides, title.fullPath)).toBe(false)

    // A block with no values left goes
    expect(withOverride(overrides, body, undefined)).toEqual({})
  })

  it("keeps an empty value as a value", () => {
    const overrides = withOverride({}, tag, "")
    expect(overrideFor(overrides, tag)).toBe("")
    expect(isOverridden(overrides, tag.fullPath)).toBe(true)
  })

  it("keeps only the values for the outputs given", () => {
    const overrides = withOverride(withOverride({}, title, "Fix it"), tag, "v2")
    expect(overridesFor(overrides, new Map([[tag.fullPath, tag]]))).toEqual({
      build: { tag: "v2" },
    })
  })

  it("puts the entered values in place of the outputs they replace", () => {
    const token = sensitiveOutput("s3cr3t")
    const outputs = { fetch_pr: { title: "Old", url: "https://x" }, other: { a: "1" } }
    const merged = applyOverrides(outputs, { fetch_pr: { title: "New" }, build: { tag: token } })

    expect(merged).toEqual({
      fetch_pr: { title: "New", url: "https://x" },
      other: { a: "1" },
      build: { tag: token },
    })
    expect(isSensitiveOutput(merged.build!.tag!)).toBe(true)
    expect(revealOutput(merged.build!.tag!)).toBe("s3cr3t")
    // No overrides, no copy
    expect(applyOverrides(outputs, {})).toBe(outputs)
  })
})
