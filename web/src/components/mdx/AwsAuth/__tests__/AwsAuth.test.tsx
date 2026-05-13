import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"

// Mock the AwsAuth component's heavy dependencies at the module level
// to avoid issues with SVG imports and complex sub-components in jsdom
vi.mock("@/assets/aws-logo.svg", () => ({ default: "aws-logo.svg" }))

vi.mock("../hooks/useAwsAuth", () => ({
  useAwsAuth: () => ({
    authStatus: "pending",
    authMethod: "credentials",
    setAuthMethod: vi.fn(),
    credentials: null,
    envCredentials: null,
    profiles: [],
    isLoadingProfiles: false,
    ssoAccounts: [],
    ssoRoles: [],
    selectedSsoAccount: null,
    error: null,
    accountInfo: null,
    handleCredentialsSubmit: vi.fn(),
    handleProfileSelect: vi.fn(),
    handleSsoStart: vi.fn(),
    handleSsoAccountSelect: vi.fn(),
    handleSsoRoleSelect: vi.fn(),
    handleAcceptEnvCredentials: vi.fn(),
    handleLogout: vi.fn(),
  }),
}))

// Mock sub-components that have complex rendering dependencies
vi.mock("../components/AuthTabs", () => ({
  AuthTabs: ({ activeTab }: { activeTab: string }) => <div data-testid="auth-tabs">Tabs: {activeTab}</div>,
}))
vi.mock("../components/AuthSuccess", () => ({
  AuthSuccess: () => <div data-testid="auth-success">Auth Success</div>,
}))
vi.mock("../components/CredentialsForm", () => ({
  CredentialsForm: () => <div data-testid="creds-form">Credentials Form</div>,
}))
vi.mock("../components/SsoFlow", () => ({
  SsoForm: () => <div>SSO Form</div>,
  SsoAccountSelector: () => <div>SSO Account</div>,
  SsoRoleSelector: () => <div>SSO Role</div>,
}))
vi.mock("../components/ProfileSelector", () => ({
  ProfileSelector: () => <div>Profile Selector</div>,
}))
vi.mock("../components/DetectedCredentialsPrompt", () => ({
  DetectedCredentialsPrompt: () => <div>Detected Credentials</div>,
}))

// Import after mocks
import AwsAuth from "../AwsAuth"

function renderAwsAuth(props: Record<string, unknown> = {}) {
  return render(
    <TestWrapper>
      <AwsAuth id="test-aws" {...props} />
    </TestWrapper>,
  )
}

describe("AwsAuth", () => {
  it("renders with default title", () => {
    renderAwsAuth()
    expect(screen.getByTestId("test-aws")).toBeInTheDocument()
    expect(screen.getByText("AWS Authentication")).toBeInTheDocument()
  })

  it("renders custom title", () => {
    renderAwsAuth({ title: "Connect to AWS" })
    expect(screen.getByText("Connect to AWS")).toBeInTheDocument()
  })

  it("renders description", () => {
    renderAwsAuth({ description: "Authenticate with your AWS account" })
    expect(screen.getByText("Authenticate with your AWS account")).toBeInTheDocument()
  })

  it("shows error for missing id", () => {
    render(
      <TestWrapper>
        <AwsAuth id="" />
      </TestWrapper>,
    )
    expect(screen.getByText(/requires a non-empty 'id' prop/)).toBeInTheDocument()
  })

  it("has no error banners with valid props", () => {
    renderAwsAuth()
    const block = screen.getByTestId("test-aws")
    expect(block.querySelector('[data-testid^="error-"]')).toBeNull()
  })
})
