import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { GitRepoInfo } from "@/types/workspace"
import type { GitWorkTree } from "@/contexts/gitWorkTreeTypes"
import { WorktreeStaticRow } from "../rows/WorktreeStaticRow"
import { WorktreeSwitcherRow } from "../rows/WorktreeSwitcherRow"

const info = (overrides: Partial<GitRepoInfo>): GitRepoInfo => ({
  repoUrl: "https://github.com/acme/infra.git",
  repoOwner: "acme",
  repoName: "infra",
  ref: "main",
  ...overrides,
})

describe("WorktreeStaticRow", () => {
  it("links an SSH clone to the repo's web page", () => {
    render(<WorktreeStaticRow gitInfo={info({ repoUrl: "git@github.com:acme/infra.git" })} />)
    expect(screen.getByRole("link", { name: "acme/infra" })).toHaveAttribute("href", "https://github.com/acme/infra")
    expect(screen.getByTestId("repo-icon-github")).toBeInTheDocument()
  })

  it("links an ssh:// clone on its hostname, without the SSH port", () => {
    render(
      <WorktreeStaticRow
        gitInfo={info({ repoUrl: "ssh://git@gl.example.com:2222/grp/sub/infra.git", repoOwner: "grp/sub" })}
      />,
    )
    expect(screen.getByRole("link", { name: "grp/sub/infra" })).toHaveAttribute(
      "href",
      "https://gl.example.com/grp/sub/infra",
    )
    // A self-hosted host doesn't say which provider it is.
    expect(screen.getByTestId("repo-icon-generic")).toBeInTheDocument()
  })

  it("shows the GitLab icon for a gitlab.com clone", () => {
    render(<WorktreeStaticRow gitInfo={info({ repoUrl: "https://gitlab.com/acme/infra.git" })} />)
    expect(screen.getByRole("link", { name: "acme/infra" })).toHaveAttribute("href", "https://gitlab.com/acme/infra")
    expect(screen.getByTestId("repo-icon-gitlab")).toBeInTheDocument()
  })

  it("renders a local checkout with no remote as plain text named after the directory", () => {
    render(<WorktreeStaticRow gitInfo={info({ repoUrl: "", repoOwner: "", repoName: "infra" })} />)
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
    expect(screen.getByText("infra")).toBeInTheDocument()
    expect(screen.queryByText("/infra")).not.toBeInTheDocument()
    expect(screen.getByTestId("repo-icon-generic")).toBeInTheDocument()
  })
})

describe("WorktreeSwitcherRow", () => {
  const workTrees: GitWorkTree[] = [
    {
      id: "clone",
      repoUrl: "https://gitlab.com/acme/infra.git",
      localPath: "/w/infra",
      gitInfo: info({ repoUrl: "https://gitlab.com/acme/infra.git" }),
    },
    {
      id: "local",
      repoUrl: "",
      localPath: "/w/scratch",
      gitInfo: info({ repoUrl: "", repoOwner: "", repoName: "scratch" }),
    },
  ]

  it("labels a worktree with no owner by its name alone, without links inside the buttons", async () => {
    render(<WorktreeSwitcherRow workTrees={workTrees} activeWorkTreeId="local" onSelect={vi.fn()} />)
    const trigger = screen.getByRole("button", { name: /scratch/ })
    expect(trigger).not.toHaveTextContent("/scratch")

    await userEvent.click(trigger)
    expect(await screen.findByRole("button", { name: /acme\/infra/ })).toBeInTheDocument()
    expect(screen.getAllByText("scratch")).toHaveLength(2)
    expect(screen.queryByText("/scratch")).not.toBeInTheDocument()
    expect(screen.getAllByTestId("repo-icon-gitlab")).toHaveLength(1)
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
  })
})
