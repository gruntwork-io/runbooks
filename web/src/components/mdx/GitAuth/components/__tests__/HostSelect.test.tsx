import { describe, it, expect, vi } from "vitest"
import type { ComponentProps } from "react"
import { render, screen, within } from "@testing-library/react"
import { HostSelect } from "../HostSelect"
import { PROVIDERS } from "../../providers"
import type { GitHostEntry } from "../../types"

const HOSTS: GitHostEntry[] = [
  { host: "gitlab.com", sources: ["glab"], hasCredential: true },
  { host: "git.corp.example", sources: ["recent"], hasCredential: false },
]

function renderHostSelect(props: Partial<ComponentProps<typeof HostSelect>> = {}) {
  return render(
    <HostSelect
      id="git"
      provider={PROVIDERS.gitlab}
      hosts={HOSTS}
      value="gitlab.com"
      onChange={vi.fn()}
      onReload={vi.fn()}
      {...props}
    />,
  )
}

const optionLabels = () =>
  within(screen.getByRole("combobox"))
    .getAllByRole("option")
    .map((o) => o.textContent)

describe("HostSelect", () => {
  it("annotates the selected host with its sources and credential, and offers Reload", () => {
    renderHostSelect()

    expect(screen.getByTestId("host-sources-git")).toHaveTextContent("glab")
    expect(screen.getByTestId("host-credential-git")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument()
  })

  it("flags a host without a credential", () => {
    renderHostSelect({ value: "git.corp.example" })

    expect(screen.getByTestId("host-no-credential-git")).toBeInTheDocument()
  })

  describe("with detectsCredentials={false}", () => {
    it("is a plain host list: no badges, key icon or Reload", () => {
      renderHostSelect({ detectsCredentials: false })

      expect(screen.getByRole("combobox")).toHaveValue("gitlab.com")
      expect(optionLabels()).toEqual(["gitlab.com", "git.corp.example", "Other instance…"])
      expect(screen.getByText("GitLab host:")).toBeInTheDocument()
      expect(screen.queryByTestId("host-sources-git")).toBeNull()
      expect(screen.queryByTestId("host-credential-git")).toBeNull()
      expect(screen.queryByRole("button", { name: "Reload" })).toBeNull()
    })

    it("does not tell the user a host has no credentials", () => {
      renderHostSelect({ detectsCredentials: false, value: "git.corp.example" })

      expect(screen.getByRole("combobox")).toHaveValue("git.corp.example")
      expect(screen.queryByTestId("host-no-credential-git")).toBeNull()
      expect(screen.queryByText(/no credentials/)).toBeNull()
    })

    it("hides the failed-validation key icon", () => {
      renderHostSelect({ detectsCredentials: false, downgradedHosts: new Set(["gitlab.com"]) })

      expect(screen.queryByTestId("host-credential-downgraded-git")).toBeNull()
    })

    it("renders nothing when there are no hosts to pick", () => {
      const { container } = renderHostSelect({ detectsCredentials: false, hosts: [] })

      expect(container).toBeEmptyDOMElement()
    })
  })
})
