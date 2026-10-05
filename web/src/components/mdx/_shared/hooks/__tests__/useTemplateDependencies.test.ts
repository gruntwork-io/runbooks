import { describe, it, expect } from "vitest"
import { createElement, type ReactNode } from "react"
import { renderHook, act } from "@testing-library/react"
import { RunbookContextProvider } from "@/contexts/RunbookContext"
import { useRunbookContext } from "@/contexts/useRunbook"
import { BoilerplateVariableType } from "@/types/boilerplateVariable"
import {
  extractTemplateDependenciesFromString,
  requireAllOutputs,
  type TemplateDependency,
} from "@/lib/extractTemplateDependencies"
import { useTemplateDependencies } from "../useTemplateDependencies"

// The hook runs inside the real RunbookContextProvider, so inputs and block
// outputs reach it through registerInputs/registerOutputs as they do in the app.

const TEMPLATE =
  '{{ .inputs.env }} {{ .outputs.mint.account_id }} {{ if hasKey .outputs.clone "org_id" }}{{ .outputs.clone.org_id }}{{ end }}'

function renderDependencies(deps: TemplateDependency[], inputsId?: string) {
  return renderHook(
    () => ({ deps: useTemplateDependencies(deps, inputsId), runbook: useRunbookContext() }),
    {
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(RunbookContextProvider, null, children),
    },
  )
}

describe("useTemplateDependencies", () => {
  it("lists every dependency, and the ones without a value yet", () => {
    const { result } = renderDependencies(extractTemplateDependenciesFromString(TEMPLATE), "form")
    const { deps } = result.current

    expect(deps.inputDeps).toEqual(["env"])
    expect(deps.outputDeps).toEqual([
      { blockId: "mint", outputName: "account_id", fullPath: "outputs.mint.account_id" },
      {
        blockId: "clone",
        outputName: "org_id",
        fullPath: "outputs.clone.org_id",
        optional: true,
      },
    ])
    expect(deps.unmetInputDeps).toEqual(["env"])
    // A block read only behind a guard is waited on without naming the output
    expect(deps.unmetOutputDeps).toEqual([
      { blockId: "mint", outputNames: ["account_id"] },
      { blockId: "clone", outputNames: [] },
    ])
    expect(deps.hasAllDependencies).toBe(false)
  })

  it("is ready once the inputs have values and the blocks have run", () => {
    const { result } = renderDependencies(extractTemplateDependenciesFromString(TEMPLATE), "form")

    act(() => {
      const { registerInputs, registerOutputs } = result.current.runbook
      registerInputs(
        "form",
        { env: "prod" },
        { variables: [{ name: "env", description: "", type: BoilerplateVariableType.String }] },
      )
      registerOutputs("mint", { account_id: "123" })
      // Ran, without the guarded output
      registerOutputs("clone", { repo: "r" })
    })

    const { deps } = result.current
    expect(deps.unmetInputDeps).toEqual([])
    expect(deps.unmetOutputDeps).toEqual([])
    expect(deps.hasAllDependencies).toBe(true)
    expect(deps.rawInputs).toEqual([
      { name: "env", type: BoilerplateVariableType.String, value: "prod" },
    ])
    expect(deps.inputs).toEqual({ env: "prod" })
    expect(deps.outputs).toEqual({ mint: { account_id: "123" }, clone: { repo: "r" } })
  })

  it("waits for a guarded output when the caller requires every output", () => {
    const { result } = renderDependencies(
      requireAllOutputs(extractTemplateDependenciesFromString(TEMPLATE)),
    )

    act(() => {
      result.current.runbook.registerOutputs("mint", { account_id: "123" })
      result.current.runbook.registerOutputs("clone", { repo: "r" })
    })

    expect(result.current.deps.unmetOutputDeps).toEqual([
      { blockId: "clone", outputNames: ["org_id"] },
    ])
  })
})
