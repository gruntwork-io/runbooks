import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import { DefaultRegionPicker } from "../components/DefaultRegionPicker"

function renderPicker(selectedRegion = "us-east-1") {
  const setSelectedRegion = vi.fn()
  render(
    <TestWrapper>
      <DefaultRegionPicker selectedRegion={selectedRegion} setSelectedRegion={setSelectedRegion} />
    </TestWrapper>,
  )
  return { setSelectedRegion }
}

describe("DefaultRegionPicker", () => {
  it("shows the GovCloud regions", async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.click(screen.getByRole("combobox"))

    expect(await screen.findByText("AWS GovCloud (US-East)")).toBeInTheDocument()
    expect(screen.getByText("AWS GovCloud (US-West)")).toBeInTheDocument()
  })

  it("selects a GovCloud region", async () => {
    const user = userEvent.setup()
    const { setSelectedRegion } = renderPicker()

    await user.click(screen.getByRole("combobox"))
    await user.click(await screen.findByText("AWS GovCloud (US-West)"))

    expect(setSelectedRegion).toHaveBeenCalledWith("us-gov-west-1")
  })

  it("labels a selected GovCloud region", () => {
    renderPicker("us-gov-east-1")

    expect(screen.getByRole("combobox")).toHaveTextContent("us-gov-east-1")
    expect(screen.getByRole("combobox")).toHaveTextContent("AWS GovCloud (US-East)")
  })
})
