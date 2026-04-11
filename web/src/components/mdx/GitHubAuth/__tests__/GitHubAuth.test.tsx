import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"

vi.mock("../hooks/useGitHubAuth", () => ({
  useGitHubAuth: () => ({
    authStatus: "pending",
    authMethod: "pat",
    setAuthMethod: vi.fn(),
    user: null,
    error: null,
    handlePatSubmit: vi.fn(),
    handleOAuthStart: vi.fn(),
    handleLogout: vi.fn(),
  }),
}))

// Mock sub-components to avoid deep dependency chains in jsdom
vi.mock("../components/AuthTabs", () => ({
  AuthTabs: ({ activeTab }: { activeTab: string }) => <div data-testid="auth-tabs">Tabs: {activeTab}</div>,
}))
vi.mock("../components/AuthSuccess", () => ({
  AuthSuccess: () => <div>Auth Success</div>,
}))
vi.mock("../components/PatForm", () => ({
  PatForm: () => <div>PAT Form</div>,
}))
vi.mock("../components/OAuthFlow", () => ({
  OAuthFlow: () => <div>OAuth Flow</div>,
}))
vi.mock("../components/CustomOAuthWarning", () => ({
  CustomOAuthWarning: () => <div>Custom OAuth Warning</div>,
}))
vi.mock("../components/GitHubLogo", () => ({
  GitHubLogo: () => <div>GitHub Logo</div>,
}))

import { GitHubAuth } from "../GitHubAuth"

function renderGitHubAuth(props: Record<string, unknown> = {}) {
  return render(
    <TestWrapper>
      <GitHubAuth id="test-gh" {...props} />
    </TestWrapper>,
  )
}

describe("GitHubAuth", () => {
  it("renders with default title", () => {
    renderGitHubAuth()
    expect(screen.getByTestId("test-gh")).toBeInTheDocument()
    expect(screen.getByText("GitHub Authentication")).toBeInTheDocument()
  })

  it("renders custom title", () => {
    renderGitHubAuth({ title: "Connect to GitHub" })
    expect(screen.getByText("Connect to GitHub")).toBeInTheDocument()
  })

  it("renders description", () => {
    renderGitHubAuth({ description: "Sign in with GitHub" })
    expect(screen.getByText("Sign in with GitHub")).toBeInTheDocument()
  })

  it("shows error for missing id", () => {
    render(
      <TestWrapper>
        <GitHubAuth id="" />
      </TestWrapper>,
    )
    expect(screen.getByText(/requires a non-empty 'id' prop/)).toBeInTheDocument()
  })

  it("has no error banners with valid props", () => {
    renderGitHubAuth()
    const block = screen.getByTestId("test-gh")
    expect(block.querySelector('[data-testid^="error-"]')).toBeNull()
  })
})
