import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { AuthSuccess } from "../AuthSuccess"
import { PROVIDERS } from "../../providers"

function renderFineGrained(host?: string) {
  render(
    <TestWrapper>
      <AuthSuccess
        userInfo={{ login: "mona" }}
        provider={PROVIDERS.github}
        detectedTokenType="fine_grained_pat"
        detectedScopes={[]}
        host={host}
      />
    </TestWrapper>,
  )
}

describe("AuthSuccess — GitHub host", () => {
  it("github.com reads plain 'GitHub' and links to github.com tokens (unchanged)", () => {
    renderFineGrained("github.com")
    expect(screen.getByText(/Authenticated to GitHub$/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /View all your tokens/ })).toHaveAttribute(
      "href",
      "https://github.com/settings/personal-access-tokens",
    )
  })

  it("an enterprise host is named and its tokens page linked", () => {
    renderFineGrained("ghes.corp")
    expect(screen.getByText(/Authenticated to GitHub \(ghes\.corp\)/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /View all your tokens/ })).toHaveAttribute(
      "href",
      "https://ghes.corp/settings/tokens",
    )
  })
})
