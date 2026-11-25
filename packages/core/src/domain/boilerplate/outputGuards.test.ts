import { describe, it, expect } from "bun:test"
import { scanGuardedCode } from "./outputGuards.ts"

const ORG_ID = "outputs.clone_repo.org_id"

/** Whether every read of clone_repo.org_id in `template` runs behind a guard for it. */
function readsGuarded(template: string): boolean {
  const reads = scanGuardedCode(template).filter(({ code }) =>
    /\.outputs\.clone_repo\.org_id\b/.test(code),
  )
  expect(reads.length).toBeGreaterThan(0)
  return reads.every(({ guarded }) => guarded.has(ORG_ID))
}

describe("scanGuardedCode", () => {
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
      "trim markers and line breaks",
      `{{- if hasKey
          .outputs.clone_repo "org_id" -}}
        --org {{ .outputs.clone_repo.org_id -}}
      {{- end }}`,
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

  it("returns no code for comments or text outside actions", () => {
    expect(scanGuardedCode(`# {{/* .outputs.clone_repo.org_id */}} .outputs.x.y`)).toEqual([])
  })
})
