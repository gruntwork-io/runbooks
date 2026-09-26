import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { GitHubBrowser } from "../GitHubBrowser"
import type { GitHubOrg, GitHubRepo } from "../../types"

const ORGS = [{ id: 1, login: "acme", type: "Organization" }] as unknown as GitHubOrg[]
const REPOS = [{ id: 2, name: "infra", private: true }] as unknown as GitHubRepo[]

function renderBrowser(host?: string) {
  const onRepoSelected = vi.fn()
  render(
    <GitHubBrowser
      host={host}
      onRepoSelected={onRepoSelected}
      onRefSelected={vi.fn()}
      fetchOrgs={vi.fn(async () => ORGS)}
      fetchRepos={vi.fn(async () => REPOS)}
      fetchRefs={vi.fn(async () => ({ refs: [], totalCount: 0, hasMore: false }))}
      initialOrg="acme"
      defaultOpen
    />,
  )
  return { onRepoSelected }
}

async function pickRepo() {
  await screen.findByText("Select repository...")
  const repoButton = screen.getAllByRole("combobox")[1]
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
