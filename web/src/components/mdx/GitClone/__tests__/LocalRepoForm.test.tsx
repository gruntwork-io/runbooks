import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { LocalRepoForm } from "../components/LocalRepoForm"

const renderForm = () => (
  <LocalRepoForm
    repoDir=""
    onRepoDirChange={vi.fn()}
    onBrowse={vi.fn()}
    previewStatus="idle"
    preview={null}
    previewError={null}
  />
)

describe("LocalRepoForm", () => {
  it("points each block's label at its own input", () => {
    // Two GitClone blocks in one runbook each render a LocalRepoForm.
    render(<>{renderForm()}{renderForm()}</>)

    const labels = screen.getAllByText("Repository directory")
    const inputs = screen.getAllByPlaceholderText("/path/to/your/repo")
    expect(inputs[0].id).not.toBe(inputs[1].id)
    labels.forEach((label, i) => {
      expect(document.getElementById(label.getAttribute("for") ?? "")).toBe(inputs[i])
    })
  })
})
