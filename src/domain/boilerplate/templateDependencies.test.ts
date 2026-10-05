import { describe, it, expect } from "bun:test"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import { extractTemplateDependenciesFromString } from "./templateDependencies.ts"

interface PatternCase {
  name: string
  input: string
  expected: Array<{ blockId: string; outputName: string }>
}

const patterns = JSON.parse(
  nodeFs.readFileSync(
    nodePath.resolve(
      import.meta.dirname,
      "../../../testdata/test-fixtures/output-dependencies/patterns.json",
    ),
    "utf8",
  ),
) as { cases: PatternCase[] }

describe("extractTemplateDependenciesFromString", () => {
  describe("output dependency patterns", () => {
    it.each(patterns.cases.map((c) => [c.name, c] as const))("%s", (_name, { input, expected }) => {
      const outputs = extractTemplateDependenciesFromString(input).flatMap((dep) =>
        dep.type === "output" ? [{ blockId: dep.blockId, outputName: dep.outputName }] : [],
      )
      expect(outputs).toEqual(expected)
    })
  })

  it("keeps the dots of an input path", () => {
    expect(extractTemplateDependenciesFromString("{{ .inputs.tags.env }}")).toEqual([
      { type: "input", name: "tags.env" },
    ])
  })

  it("lists dependencies in the order they first appear", () => {
    expect(
      extractTemplateDependenciesFromString(
        "{{ .inputs.region }} {{ .outputs.deploy.result }} {{ .inputs.env }} {{ .inputs.region }}",
      ),
    ).toEqual([
      { type: "input", name: "region" },
      {
        type: "output",
        blockId: "deploy",
        outputName: "result",
        fullPath: "outputs.deploy.result",
      },
      { type: "input", name: "env" },
    ])
  })

  it("merges several templates, skipping empty ones", () => {
    expect(
      extractTemplateDependenciesFromString(
        "{{ .inputs.region }}",
        "",
        "{{ .outputs.create-account.id }} {{ .inputs.region }}",
        "{{ .outputs.create_account.id }}",
      ),
    ).toEqual([
      { type: "input", name: "region" },
      {
        type: "output",
        blockId: "create-account",
        outputName: "id",
        fullPath: "outputs.create_account.id",
      },
    ])
  })

  it("keeps an output optional only when every template guards it", () => {
    const guarded =
      '{{ if hasKey .outputs.clone_repo "org_id" }}{{ .outputs.clone_repo.org_id }}{{ end }}'
    const required = {
      type: "output" as const,
      blockId: "clone_repo",
      outputName: "org_id",
      fullPath: "outputs.clone_repo.org_id",
    }

    expect(extractTemplateDependenciesFromString(guarded, guarded)).toEqual([
      { ...required, optional: true },
    ])
    expect(
      extractTemplateDependenciesFromString(guarded, "{{ .outputs.clone_repo.org_id }}", guarded),
    ).toEqual([required])
  })

  it("does not carry a guard from one template into the next", () => {
    // The `if` opens in the first template; the second reads the output with
    // no guard of its own.
    expect(
      extractTemplateDependenciesFromString(
        '{{ if hasKey .outputs.clone_repo "org_id" }}',
        "{{ .outputs.clone_repo.org_id }}{{ end }}",
      ),
    ).toEqual([
      {
        type: "output",
        blockId: "clone_repo",
        outputName: "org_id",
        fullPath: "outputs.clone_repo.org_id",
      },
    ])
  })
})
