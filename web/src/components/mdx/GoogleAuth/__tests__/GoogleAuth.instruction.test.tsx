import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"

vi.mock("@/contexts/useInstructionMode", () => ({
  useInstructionMode: () => ({ enabled: true, setEnabled: vi.fn() }),
}))

// If the interactive path were taken, this hook would run and kick off
// credential detection on mount. Spy on it to prove instruction mode never
// reaches it — that is the whole reason the instruction render is a sibling
// component rather than a branch inside the interactive one.
const useGoogleAuthSpy = vi.fn(() => ({ authStatus: "pending" }))
vi.mock("../hooks/useGoogleAuth", () => ({
  useGoogleAuth: () => useGoogleAuthSpy(),
}))

import GoogleAuth from "../GoogleAuth"

const DEFAULT_SCOPES =
  "https://www.googleapis.com/auth/cloud-platform, https://www.googleapis.com/auth/userinfo.email, openid"

describe("GoogleAuth — instruction mode", () => {
  it('renders a plain "Log into Google Cloud" instruction with no credential capture', () => {
    render(
      <TestWrapper>
        <GoogleAuth id="gcp" />
      </TestWrapper>,
    )

    expect(screen.getByTestId("instruction-gcp")).toBeInTheDocument()
    expect(screen.getByText("Log into Google Cloud")).toBeInTheDocument()
    // The by-hand equivalent of every tab, and the scopes it would request.
    expect(screen.getByText("gcloud auth application-default login")).toBeInTheDocument()
    expect(screen.getByText(DEFAULT_SCOPES)).toBeInTheDocument()

    // No credential capture UI of any kind.
    expect(screen.queryByLabelText("Service account key JSON")).toBeNull()
    expect(screen.queryByRole("button", { name: "Authenticate" })).toBeNull()
    expect(screen.queryByRole("button", { name: /Sign in with Google/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Service Account Key" })).toBeNull()
    expect(useGoogleAuthSpy).not.toHaveBeenCalled()
  })

  it("qualifies the heading with the project and lists the configured hints", () => {
    render(
      <TestWrapper>
        <GoogleAuth
          id="gcp"
          project="my-gcp-project"
          defaultRegion="us-central1"
          gcloudConfiguration="prod"
          description="Use the platform-admin account."
          scopes={["https://www.googleapis.com/auth/cloud-platform"]}
        />
      </TestWrapper>,
    )

    expect(screen.getByText(/Log into Google Cloud in the/i)).toBeInTheDocument()
    // Project appears in the heading and in the hint list.
    expect(screen.getAllByText("my-gcp-project")).not.toHaveLength(0)
    expect(screen.getByText("us-central1")).toBeInTheDocument()
    expect(screen.getByText("prod")).toBeInTheDocument()
    expect(screen.getByText("Use the platform-admin account.")).toBeInTheDocument()
    // Author-supplied scopes replace the defaults in the hint and appear on the
    // by-hand gcloud command.
    expect(screen.getByText("https://www.googleapis.com/auth/cloud-platform")).toBeInTheDocument()
    expect(screen.queryByText(DEFAULT_SCOPES)).toBeNull()
    expect(
      screen.getByText(
        "gcloud auth application-default login --scopes=https://www.googleapis.com/auth/cloud-platform",
      ),
    ).toBeInTheDocument()
    expect(useGoogleAuthSpy).not.toHaveBeenCalled()
  })

  it("puts the author's OAuth client file on the command", () => {
    render(
      <TestWrapper>
        <GoogleAuth id="gcp" oauthClientFile="~/.config/gcloud/client.json" />
      </TestWrapper>,
    )

    expect(
      screen.getAllByText(
        "gcloud auth application-default login --client-id-file ~/.config/gcloud/client.json",
      ),
    ).toHaveLength(1)
  })

  it("leaves out the gcloud command and configuration when only a key signs in", () => {
    render(
      <TestWrapper>
        <GoogleAuth id="gcp" methods={["service_account"]} gcloudConfiguration="prod" />
      </TestWrapper>,
    )

    expect(screen.getAllByText("Log into Google Cloud")).toHaveLength(1)
    expect(screen.queryAllByText(/gcloud auth application-default login/)).toHaveLength(0)
    expect(screen.queryAllByText("prod")).toHaveLength(0)
  })

  it("keeps the command when Google Sign-In is the only method", () => {
    render(
      <TestWrapper>
        <GoogleAuth id="gcp" methods={["oauth"]} />
      </TestWrapper>,
    )

    expect(screen.getAllByText("gcloud auth application-default login")).toHaveLength(1)
  })

  it("quotes a client file path the shell would otherwise split or expand", () => {
    render(
      <TestWrapper>
        <GoogleAuth id="gcp" oauthClientFile="/Users/o'brien/My Keys/client $1.json" />
      </TestWrapper>,
    )

    expect(
      screen.getAllByText(
        `gcloud auth application-default login --client-id-file '/Users/o'\\''brien/My Keys/client $1.json'`,
      ),
    ).toHaveLength(1)
  })
})
