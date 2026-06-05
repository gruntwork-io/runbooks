import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"

// Capture the hook's options + expose controllable returns.
const hookCalls: Array<Record<string, unknown>> = []
const cancelOAuth = vi.fn()
const clearRegisteredOutputs = vi.fn()
const resetAuth = vi.fn()

vi.mock("../hooks/useGitAuth", () => ({
  useGitAuth: (opts: Record<string, unknown>) => {
    hookCalls.push(opts)
    return {
      authStatus: "pending",
      authMethod: "pat",
      setAuthMethod: vi.fn(),
      detectionStatus: "done",
      detectionAttemptedRef: { current: false },
      userInfo: null,
      errorMessage: null,
      patToken: "",
      setPatToken: vi.fn(),
      showPatToken: false,
      setShowPatToken: vi.fn(),
      handlePatSubmit: vi.fn(),
      startOAuth: vi.fn(),
      cancelOAuth,
      resetAuth,
      resetDetectionState: vi.fn(),
      clearRegisteredOutputs,
      effectiveClientId: "client-id",
      isCustomClientId: false,
    }
  },
}))

// trackBlockRender spy via the telemetry hook.
const trackBlockRender = vi.fn()
vi.mock("@/contexts/useTelemetry", () => ({
  useTelemetry: () => ({ trackBlockRender }),
}))

import { GitAuth } from "../GitAuth"

function renderGitAuth(props: Record<string, unknown> = {}) {
  return render(
    <TestWrapper>
      <GitAuth id="git" {...props} />
    </TestWrapper>,
  )
}

beforeEach(() => {
  hookCalls.length = 0
  trackBlockRender.mockClear()
  cancelOAuth.mockClear()
  clearRegisteredOutputs.mockClear()
  resetAuth.mockClear()
})

describe("GitAuth", () => {
  it("defaults to GitHub with the generic title and a visible provider picker", () => {
    renderGitAuth()
    expect(screen.getByText("Git Authentication")).toBeInTheDocument()
    // Provider picker is shown by default.
    const picker = screen.getByRole("tablist", { name: "Git provider" })
    expect(picker).toBeInTheDocument()
    // Default provider passed to the hook is GitHub.
    expect((hookCalls[0].provider as { id: string }).id).toBe("github")
  })

  it("preselects GitLab when provider='gitlab' (PAT only, no OAuth)", () => {
    renderGitAuth({ provider: "gitlab" })
    expect((hookCalls[0].provider as { id: string }).id).toBe("gitlab")
    // GitLab tab is selected in the picker.
    const gitlabTab = screen.getByRole("tab", { name: /GitLab/ })
    expect(gitlabTab).toHaveAttribute("aria-selected", "true")
  })

  it("hides the provider picker when hideProviderSelect is set", () => {
    renderGitAuth({ hideProviderSelect: true })
    expect(screen.queryByRole("tablist", { name: "Git provider" })).toBeNull()
  })

  it("switching providers cancels OAuth, clears outputs, and resets", () => {
    renderGitAuth()
    const gitlabTab = screen.getByRole("tab", { name: /GitLab/ })
    fireEvent.click(gitlabTab)
    expect(cancelOAuth).toHaveBeenCalled()
    expect(clearRegisteredOutputs).toHaveBeenCalled()
    expect(resetAuth).toHaveBeenCalled()
    // After switching, the hook is re-invoked with the gitlab provider.
    expect((hookCalls.at(-1)!.provider as { id: string }).id).toBe("gitlab")
  })

  it("reports telemetry/registry identity as 'GitAuth' by default", () => {
    renderGitAuth()
    expect(trackBlockRender).toHaveBeenCalledWith("GitAuth")
  })

  it("honors an internal __registryType override (alias support)", () => {
    render(
      <TestWrapper>
        <GitAuth id="git" __registryType="GitHubAuth" />
      </TestWrapper>,
    )
    expect(trackBlockRender).toHaveBeenCalledWith("GitHubAuth")
  })

  it("shows an error for a missing id", () => {
    render(
      <TestWrapper>
        <GitAuth id="" />
      </TestWrapper>,
    )
    expect(screen.getByText(/requires a non-empty 'id' prop/)).toBeInTheDocument()
  })
})
