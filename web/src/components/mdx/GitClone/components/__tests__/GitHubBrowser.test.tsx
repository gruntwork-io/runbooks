import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { GitHubBrowser } from "../GitHubBrowser"
import type { GitHubOrg, GitHubRepo } from "../../types"

const ORGS: GitHubOrg[] = [{ id: 1, login: "acme" }]
const REPOS: GitHubRepo[] = [
  {
    id: 2,
    ownerId: 1,
    name: "infra",
    fullName: "acme/infra",
    private: true,
    defaultBranch: "main",
  },
]

function renderBrowser(host?: string) {
  const onRepoSelected = vi.fn()
  render(
    <GitHubBrowser
      host={host}
      onRepoSelected={onRepoSelected}
      onRefSelected={vi.fn()}
      fetchOrgs={vi.fn(async () => ORGS)}
      fetchRepos={vi.fn(async () => REPOS)}
      fetchRefs={vi.fn(async () => [])}
      initialOrg="acme"
      defaultOpen
    />,
  )
  return { onRepoSelected }
}

async function pickRepo() {
  await screen.findByText("Select repository...")
  const repoButton = screen.getAllByRole("combobox")[1]!
  await waitFor(() => expect(repoButton).not.toBeDisabled())
  fireEvent.click(repoButton)
  fireEvent.click(await screen.findByText("infra"))
}

describe("GitHubBrowser — clone URL host", () => {
  it("builds github.com clone URLs by default", async () => {
    const { onRepoSelected } = renderBrowser()
    await pickRepo()
    expect(onRepoSelected).toHaveBeenCalledWith("https://github.com/acme/infra")
  })

  it("builds clone URLs on the linked GitHub Enterprise host", async () => {
    const { onRepoSelected } = renderBrowser("ghes.corp:8443")
    await pickRepo()
    expect(onRepoSelected).toHaveBeenCalledWith("https://ghes.corp:8443/acme/infra")
  })
})
