import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { OnePasswordItem } from "../OnePasswordItem"

vi.mock("@/contexts/useInstructionMode", () => ({
  useInstructionMode: () => ({ enabled: true, setEnabled: vi.fn() }),
}))

const useOnePasswordItemSpy = vi.fn()
vi.mock("../hooks/useOnePasswordItem", () => ({
  useOnePasswordItem: () => useOnePasswordItemSpy(),
}))

describe("OnePasswordItem — instruction mode", () => {
  it("shows the op command and saves nothing", () => {
    render(
      <TestWrapper>
        <OnePasswordItem id="save" vault="Ops" itemTitle="AWS prod" username="terraform" />
      </TestWrapper>,
    )
    expect(screen.getByText("Save this item to 1Password:")).toBeInTheDocument()
    expect(screen.getByText(/op item create\s+\\\s+--vault 'Ops'/)).toBeInTheDocument()
    expect(screen.getByText(/'username=terraform'/)).toBeInTheDocument()
    expect(useOnePasswordItemSpy).not.toHaveBeenCalled()
  })
})
