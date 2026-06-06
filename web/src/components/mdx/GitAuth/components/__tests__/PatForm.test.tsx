import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { PatForm } from "../PatForm"
import { PROVIDERS } from "../../providers"

function renderPatForm(props: Partial<React.ComponentProps<typeof PatForm>> = {}) {
  const defaults: React.ComponentProps<typeof PatForm> = {
    authStatus: "pending",
    patToken: "",
    setPatToken: vi.fn(),
    showPatToken: false,
    setShowPatToken: vi.fn(),
    onSubmit: vi.fn(),
    provider: PROVIDERS.gitlab,
  }
  return render(
    <TestWrapper>
      <PatForm {...defaults} {...props} />
    </TestWrapper>,
  )
}

describe("PatForm — GitLab self-hosted instance field", () => {
  it("shows the Instance URL field for GitLab and reports edits", () => {
    const setInstanceUrl = vi.fn()
    renderPatForm({ instanceUrl: "", setInstanceUrl })

    const field = screen.getByPlaceholderText("https://gitlab.com")
    expect(field).toBeInTheDocument()

    fireEvent.change(field, { target: { value: "https://gitlab.acme.com" } })
    expect(setInstanceUrl).toHaveBeenCalledWith("https://gitlab.acme.com")
  })

  it("does not show the Instance URL field for GitHub", () => {
    renderPatForm({ provider: PROVIDERS.github, instanceUrl: "", setInstanceUrl: vi.fn() })
    expect(screen.queryByText("GitLab Instance URL")).toBeNull()
  })

  it("omits the field when no setInstanceUrl handler is wired", () => {
    renderPatForm({ setInstanceUrl: undefined })
    expect(screen.queryByText("GitLab Instance URL")).toBeNull()
  })

  it("points the create-token link at the self-hosted instance", () => {
    renderPatForm({ instanceUrl: "https://gitlab.acme.com", setInstanceUrl: vi.fn() })

    // The setup guide (with the token link) is collapsed by default.
    fireEvent.click(screen.getByText("How do I create a token?"))

    const link = screen.getByRole("link", {
      name: /gitlab\.acme\.com\/-\/user_settings\/personal_access_tokens/,
    })
    expect(link).toHaveAttribute(
      "href",
      "https://gitlab.acme.com/-/user_settings/personal_access_tokens",
    )
  })

  it("falls back to the gitlab.com create-token link when no instance is set", () => {
    renderPatForm({ instanceUrl: "", setInstanceUrl: vi.fn() })
    fireEvent.click(screen.getByText("How do I create a token?"))

    const link = screen.getByRole("link", {
      name: /gitlab\.com\/-\/user_settings\/personal_access_tokens/,
    })
    expect(link).toHaveAttribute(
      "href",
      "https://gitlab.com/-/user_settings/personal_access_tokens",
    )
  })
})
