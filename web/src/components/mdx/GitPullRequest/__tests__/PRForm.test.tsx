import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { ComponentProps } from "react"

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: () => <textarea aria-label="description" />,
}))

import { PRForm } from "../components/PRForm"
import { PR_PROVIDERS } from "../providers"
import type { ChangeSummary } from "../types"

const noun = PR_PROVIDERS.gitlab.noun

function renderForm(opts: {
  changeSummary?: ChangeSummary | null
  commitsAhead: number | null
  freshCommitsAhead?: number | null
}) {
  const onSubmit = vi.fn()
  const refreshCommitsAhead = vi.fn(async () =>
    opts.freshCommitsAhead === undefined ? opts.commitsAhead : opts.freshCommitsAhead,
  )
  const props: ComponentProps<typeof PRForm> = {
    noun,
    providerLabel: "GitLab",
    prTitle: "Provision",
    setPRTitle: vi.fn(),
    prDescription: "",
    setPRDescription: vi.fn(),
    branchName: "provision-tenant",
    setBranchName: vi.fn(),
    commitMessage: "",
    setCommitMessage: vi.fn(),
    defaultCommitMessage: "Changes",
    selectedLabels: [],
    setSelectedLabels: vi.fn(),
    availableLabels: [],
    labelsLoading: false,
    changeSummary: opts.changeSummary ?? null,
    commitsAhead: opts.commitsAhead,
    refreshCommitsAhead,
    status: "ready",
    disabled: false,
    onSubmit,
    onCancel: vi.fn(),
  }
  render(<PRForm {...props} />)
  return { onSubmit, refreshCommitsAhead }
}

const clickCreate = () =>
  fireEvent.click(screen.getByRole("button", { name: "Create Merge Request" }))

describe("PRForm no-changes confirmation", () => {
  it("warns when there are no file changes and no commits ahead of the base", async () => {
    const { onSubmit } = renderForm({ commitsAhead: 0 })

    clickCreate()

    expect(await screen.findByText("No file changes detected")).toBeInTheDocument()
    expect(screen.queryByText(/empty commit/)).toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("submits without a warning when the branch has commits the base lacks", async () => {
    const { onSubmit, refreshCommitsAhead } = renderForm({ commitsAhead: 3 })

    clickCreate()

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(refreshCommitsAhead).toHaveBeenCalled()
    expect(screen.queryByText("No file changes detected")).toBeNull()
  })

  it("goes by a fresh count, so a commit made after the last query still counts", async () => {
    const { onSubmit } = renderForm({ commitsAhead: 0, freshCommitsAhead: 1 })

    clickCreate()

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(screen.queryByText("No file changes detected")).toBeNull()
  })

  it("submits straight away when there are file changes", () => {
    const { onSubmit, refreshCommitsAhead } = renderForm({
      changeSummary: { fileCount: 2, additions: 5, deletions: 1 },
      commitsAhead: 0,
    })

    clickCreate()

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(refreshCommitsAhead).not.toHaveBeenCalled()
  })

  it("says how many commits will be included", () => {
    renderForm({ commitsAhead: 3 })

    fireEvent.click(screen.getByText("What files will be committed?"))

    expect(screen.getByText(/There are no uncommitted file changes/)).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument()
    expect(screen.getByText(/commits already on this branch/)).toBeInTheDocument()
  })
})
