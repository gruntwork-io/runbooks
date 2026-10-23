import { describe, it, expect } from "bun:test"
import { scriptTemplateWarning } from "./scriptTemplates.ts"

const ADVICE = "Pass values in the block's env prop instead, so they reach the script as data."
const OUTPUTS =
  "An output can hold text from outside the runbook, which the shell would run as code."

describe("scriptTemplateWarning", () => {
  it("has nothing to say about a script that reads env vars", () => {
    expect(scriptTemplateWarning('aws s3 mb "s3://$BUCKET"')).toBeNull()
    expect(scriptTemplateWarning("")).toBeNull()
  })

  it("ignores Go-template text that isn't an input or output", () => {
    expect(scriptTemplateWarning("docker ps --format '{{.Names}}'")).toBeNull()
    expect(scriptTemplateWarning("{{/* .inputs.Name */}}echo hi")).toBeNull()
  })

  it("names each input once", () => {
    expect(
      scriptTemplateWarning(
        'echo "{{ .inputs.Name }}" && echo "{{ .inputs.Name }}, {{ .inputs.Env }}"',
      ),
    ).toBe(
      `This script inserts {{ .inputs.Name }} and {{ .inputs.Env }} into its source. ${ADVICE}`,
    )
  })

  it("counts an input in template logic too", () => {
    expect(scriptTemplateWarning('{{ if eq .inputs.Language "Go" }}go build{{ end }}')).toBe(
      `This script inserts {{ .inputs.Language }} into its source. ${ADVICE}`,
    )
  })

  it("says why an output is worse, writing the block ID as templates read it", () => {
    expect(scriptTemplateWarning('gh pr edit --title "{{ .outputs.fetch-pr.title }}"')).toBe(
      `This script inserts {{ .outputs.fetch_pr.title }} into its source. ${ADVICE} ${OUTPUTS}`,
    )
  })

  it("counts the references past the first few", () => {
    const script = ["A", "B", "C", "D", "E"].map((n) => `echo {{ .inputs.${n} }}`).join("\n")
    expect(scriptTemplateWarning(script)).toBe(
      `This script inserts {{ .inputs.A }}, {{ .inputs.B }}, {{ .inputs.C }} and 2 more into its source. ${ADVICE}`,
    )
  })
})
