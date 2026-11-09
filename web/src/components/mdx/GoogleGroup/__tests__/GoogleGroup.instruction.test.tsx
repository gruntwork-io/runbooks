import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { GoogleGroup } from "../GoogleGroup"

vi.mock("@/contexts/useInstructionMode", () => ({
  useInstructionMode: () => ({ enabled: true, setEnabled: vi.fn() }),
}))

const useGoogleGroupSpy = vi.fn()
vi.mock("../hooks/useGoogleGroup", () => ({
  useGoogleGroup: () => useGoogleGroupSpy(),
}))

describe("GoogleGroup — instruction mode", () => {
  it("shows the gcloud commands and creates nothing", () => {
    render(
      <TestWrapper>
        <GoogleGroup
          id="create-group"
          email="ops@example.com"
          members={["josh@example.com"]}
          allowExternalSenders
        />
      </TestWrapper>,
    )
    expect(screen.getByText("Create this Google group:")).toBeInTheDocument()
    expect(screen.getByText(/gcloud identity groups create 'ops@example.com'/)).toBeInTheDocument()
    expect(screen.getByText(/--member-email='josh@example.com'/)).toBeInTheDocument()
    expect(screen.getByText(/Anyone on the web/)).toBeInTheDocument()
    expect(useGoogleGroupSpy).not.toHaveBeenCalled()
  })
})
