import { describe, expect, it } from "bun:test"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import { outputsRead, type OutputReference, templateReferences } from "./templateReferences.ts"

interface PatternCase {
  name: string
  input: string
  expected: Array<{ blockId: string; outputName: string }>
}

const patterns = JSON.parse(
  nodeFs.readFileSync(
    nodePath.resolve(
      import.meta.dirname,
      "../../../../testdata/test-fixtures/output-dependencies/patterns.json",
    ),
    "utf8",
  ),
) as { cases: PatternCase[] }

const outputs = (template: string) =>
  templateReferences(template).filter((ref): ref is OutputReference => ref._tag === "Output")

/** Whether every read of clone_repo.org_id in `template` runs behind a guard for it. */
function readsGuarded(template: string): boolean {
  const reads = outputs(template).filter(
    (ref) => ref.block === "clone_repo" && ref.key === "org_id",
  )
  expect(reads.length).toBeGreaterThan(0)
  return reads.every((ref) => ref.guarded)
}

describe("templateReferences", () => {
  describe("output dependency patterns", () => {
    it.each(patterns.cases.map((c) => [c.name, c] as const))("%s", (_name, { input, expected }) => {
      expect(
        outputsRead(input).map((read) => ({
          blockId: read.blockAsWritten,
          outputName: read.key,
        })),
      ).toEqual(expected)
    })
  })

  it("gives each reference's line and column, end exclusive", () => {
    const refs = templateReferences("a\n  {{ .outputs.deploy.url }} {{ .inputs.region }}")
    expect(refs.map((ref) => ref.span)).toEqual([
      { start: { line: 2, column: 6 }, end: { line: 2, column: 25 } },
      { start: { line: 2, column: 32 }, end: { line: 2, column: 46 } },
    ])
  })

  it("places a reference in an action that spans lines and trims", () => {
    const template = `{{- if hasKey
          .outputs.clone_repo "org_id" -}}
        --org {{ .outputs.clone_repo.org_id -}}
      {{- end }}`
    expect(outputs(template)).toEqual([
      {
        _tag: "Output",
        block: "clone_repo" as OutputReference["block"],
        blockAsWritten: "clone_repo",
        key: "org_id",
        guarded: true,
        span: { start: { line: 3, column: 18 }, end: { line: 3, column: 44 } },
      },
    ])
  })

  it("names a block by the one id comparison, keeping the id as written", () => {
    const [ref] = outputs("{{ .outputs.create-account.id }}")
    expect(ref?.block).toBe("create_account" as OutputReference["block"])
    expect(ref?.blockAsWritten).toBe("create-account")
  })

  it("keeps the dots of an input path", () => {
    expect(templateReferences("{{ .inputs.tags.env }}")).toMatchObject([
      { _tag: "Input", path: "tags.env" },
    ])
  })

  it("lists every reference in the order written, repeats included", () => {
    expect(
      templateReferences(
        "{{ .inputs.region }} {{ .outputs.deploy.result }} {{ .inputs.env }} {{ .inputs.region }}",
      ).map((ref) => (ref._tag === "Input" ? ref.path : `${ref.block}.${ref.key}`)),
    ).toEqual(["region", "deploy.result", "env", "region"])
  })

  it("returns nothing for comments or text outside actions", () => {
    expect(templateReferences(`# {{/* .outputs.clone_repo.org_id */}} .outputs.x.y`)).toEqual([])
  })

  it.each([
    [
      "an if hasKey branch",
      `{{ if hasKey .outputs.clone_repo "org_id" }}{{ .outputs.clone_repo.org_id }}{{ end }}`,
    ],
    [
      "a parenthesized map and backquoted key",
      "{{ if hasKey (.outputs.clone_repo) `org_id` }}{{ .outputs.clone_repo.org_id }}{{ end }}",
    ],
    [
      "a parenthesized condition",
      `{{ if (hasKey .outputs.clone_repo "org_id") }}{{ .outputs.clone_repo.org_id }}{{ end }}`,
    ],
    [
      "a guard on the hyphenated id",
      `{{ if hasKey .outputs.clone-repo "org_id" }}{{ .outputs.clone_repo.org_id }}{{ end }}`,
    ],
    [
      "the root map inside range",
      `{{ range .inputs.envs }}{{ if hasKey $.outputs.clone_repo "org_id" }}{{ $.outputs.clone_repo.org_id }}{{ end }}{{ end }}`,
    ],
    [
      "a with nested in the guarded branch",
      `{{ if hasKey .outputs.clone_repo "org_id" }}{{ with .inputs.env }}{{ $.outputs.clone_repo.org_id }}{{ end }}{{ end }}`,
    ],
    [
      "the else branch of a negated guard",
      `{{ if not (hasKey .outputs.clone_repo "org_id") }}none{{ else }}{{ .outputs.clone_repo.org_id }}{{ end }}`,
    ],
    [
      "an and condition, including its later arguments",
      `{{ if and (hasKey .outputs.clone_repo "org_id") (ne .outputs.clone_repo.org_id "") }}{{ .outputs.clone_repo.org_id }}{{ end }}`,
    ],
    [
      "an else if branch",
      `{{ if eq .inputs.env "dev" }}dev{{ else if hasKey .outputs.clone_repo "org_id" }}{{ .outputs.clone_repo.org_id }}{{ end }}`,
    ],
    [
      "an else after a negated else if",
      `{{ if eq .inputs.env "dev" }}dev{{ else if not (hasKey .outputs.clone_repo "org_id") }}none{{ else }}{{ .outputs.clone_repo.org_id }}{{ end }}`,
    ],
  ])("guards a read inside %s", (_, template) => {
    expect(readsGuarded(template)).toBe(true)
  })

  it.each([
    [
      "after the guarded branch ends",
      `{{ if hasKey .outputs.clone_repo "org_id" }}{{ .outputs.clone_repo.org_id }}{{ end }}{{ .outputs.clone_repo.org_id }}`,
    ],
    [
      "in the guard's else branch",
      `{{ if hasKey .outputs.clone_repo "org_id" }}x{{ else }}{{ .outputs.clone_repo.org_id }}{{ end }}`,
    ],
    [
      "in a negated guard's own branch",
      `{{ if not (hasKey .outputs.clone_repo "org_id") }}{{ .outputs.clone_repo.org_id }}{{ end }}`,
    ],
    [
      "after a hasKey that is only printed",
      `{{ hasKey .outputs.clone_repo "org_id" }}{{ .outputs.clone_repo.org_id }}`,
    ],
    [
      "after a hasKey in a comment",
      `{{/* hasKey .outputs.clone_repo "org_id" */}}{{ .outputs.clone_repo.org_id }}`,
    ],
    [
      "behind a guard on another key",
      `{{ if hasKey .outputs.clone_repo "repo_id" }}{{ .outputs.clone_repo.org_id }}{{ end }}`,
    ],
    [
      "behind an or condition",
      `{{ if or (hasKey .outputs.clone_repo "org_id") .inputs.force }}{{ .outputs.clone_repo.org_id }}{{ end }}`,
    ],
    [
      "in an and argument before the guard",
      `{{ if and (ne .outputs.clone_repo.org_id "") (hasKey .outputs.clone_repo "org_id") }}x{{ end }}`,
    ],
    [
      "behind a guard piped into another function",
      `{{ if hasKey .outputs.clone_repo "org_id" | not }}{{ .outputs.clone_repo.org_id }}{{ end }}`,
    ],
    [
      "behind a guard on a variable",
      `{{ $o := .outputs.clone_repo }}{{ if hasKey $o "org_id" }}{{ .outputs.clone_repo.org_id }}{{ end }}`,
    ],
    [
      "in a define, whose body runs where it's called",
      `{{ define "org" }}{{ .outputs.clone_repo.org_id }}{{ end }}`,
    ],
  ])("leaves a read %s unguarded", (_, template) => {
    expect(readsGuarded(template)).toBe(false)
  })
})

describe("outputsRead", () => {
  const guarded =
    '{{ if hasKey .outputs.clone_repo "org_id" }}{{ .outputs.clone_repo.org_id }}{{ end }}'
  const orgId = { blockAsWritten: "clone_repo", key: "org_id" }

  it("reads each output once, across templates, in the order first read", () => {
    expect(
      outputsRead(
        "{{ .inputs.region }}",
        "",
        "{{ .outputs.create-account.id }} {{ .outputs.deploy.url }}",
        "{{ .outputs.create_account.id }}",
      ),
    ).toMatchObject([
      { block: "create_account", blockAsWritten: "create-account", key: "id", optional: false },
      { block: "deploy", key: "url", optional: false },
    ])
  })

  it("keeps an output optional only when every template guards it", () => {
    expect(outputsRead(guarded, guarded)).toMatchObject([{ ...orgId, optional: true }])
    expect(outputsRead(guarded, "{{ .outputs.clone_repo.org_id }}", guarded)).toMatchObject([
      { ...orgId, optional: false },
    ])
  })

  it("does not carry a guard from one template into the next", () => {
    // The `if` opens in the first template; the second reads the output with
    // no guard of its own.
    expect(
      outputsRead(
        '{{ if hasKey .outputs.clone_repo "org_id" }}',
        "{{ .outputs.clone_repo.org_id }}{{ end }}",
      ),
    ).toMatchObject([{ ...orgId, optional: false }])
  })
})
