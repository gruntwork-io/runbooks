import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { ComponentProps } from "react"
import { BoilerplateInputsForm } from "../BoilerplateInputsForm"
import type { BoilerplateConfig } from "@/types/boilerplateConfig"
import { BoilerplateValidationType } from "@/types/boilerplateVariable"

const config: BoilerplateConfig = {
  variables: [{ name: "region", type: "string", description: "", default: "us-east-1" }],
}

function renderForm(props: Partial<ComponentProps<typeof BoilerplateInputsForm>> = {}) {
  const onGenerate = vi.fn()
  const element = (overrides: Partial<ComponentProps<typeof BoilerplateInputsForm>> = {}) => (
    <BoilerplateInputsForm
      id="tpl"
      boilerplateConfig={config}
      onGenerate={onGenerate}
      enableAutoRender={false}
      variant="standard"
      {...props}
      {...overrides}
    />
  )
  const utils = render(element())
  const block = () => utils.container.querySelector(".runbook-block") as HTMLElement
  return {
    ...utils,
    onGenerate,
    block,
    rerenderWith: (o: Partial<ComponentProps<typeof BoilerplateInputsForm>>) =>
      utils.rerender(element(o)),
  }
}

// Success is controlled by the parent: clicking Generate only requests a
// render, which may still fail.
describe("BoilerplateInputsForm success state", () => {
  it("stays neutral and keeps the Generate button until the parent reports success", () => {
    const { onGenerate, block, rerenderWith } = renderForm({ hasGeneratedSuccessfully: false })

    fireEvent.click(screen.getByRole("button", { name: "Generate" }))
    expect(onGenerate).toHaveBeenCalledWith({ region: "us-east-1" })
    expect(block().className).not.toContain("bg-success-muted")
    expect(screen.getByRole("button", { name: "Generate" })).toBeInTheDocument()
    expect(screen.queryByText("Up to date")).toBeNull()

    rerenderWith({ hasGeneratedSuccessfully: true })
    expect(block().className).toContain("bg-success-muted")
    expect(screen.getByText("Up to date")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull()
  })

  it("drops the success styling and reports the failure when a later render fails", () => {
    const { block } = renderForm({ hasGeneratedSuccessfully: true, hasRenderError: true })

    expect(block().className).not.toContain("bg-success-muted")
    expect(screen.queryByText("Up to date")).toBeNull()
    expect(screen.getByText(/Generation failed/)).toBeInTheDocument()
  })
})

// A required tuple starts from the elements its controls display, and is only
// "required" while those still read as blank.
describe("BoilerplateInputsForm required tuples", () => {
  const tupleConfig = (schema: Record<string, string>): BoilerplateConfig => ({
    variables: [
      {
        name: "Pair",
        type: "list",
        description: "",
        schema,
        required: true,
        validations: [{ type: BoilerplateValidationType.Required }],
      },
    ],
  })

  it("generates an untouched tuple of bools with the false both selects show", () => {
    const { onGenerate } = renderForm({
      boilerplateConfig: tupleConfig({ "0": "bool", "1": "bool" }),
    })

    fireEvent.click(screen.getByRole("button", { name: "Generate" }))

    expect(screen.queryByText(/is required/)).toBeNull()
    expect(onGenerate).toHaveBeenCalledWith({ Pair: [false, false] })
  })

  it("reports a tuple whose string element is blank as required, next to a bool showing false", () => {
    const { onGenerate } = renderForm({
      boilerplateConfig: tupleConfig({ "0": "string", "1": "bool" }),
    })

    fireEvent.click(screen.getByRole("button", { name: "Generate" }))

    expect(screen.getAllByText(/is required/).length).toBeGreaterThan(0)
    expect(onGenerate).not.toHaveBeenCalled()
  })
})
