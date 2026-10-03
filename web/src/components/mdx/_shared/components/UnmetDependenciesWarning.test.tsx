import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { UnmetDependenciesWarning } from "./UnmetDependenciesWarning"

describe("UnmetDependenciesWarning", () => {
  it("names the outputs a block is waited on for", () => {
    render(
      <UnmetDependenciesWarning
        blockType="template"
        unmetInputDeps={[]}
        unmetOutputDeps={[{ blockId: "clone_repo", outputNames: ["repo_owner", "repo_name"] }]}
      />,
    )
    expect(screen.getByText(/Waiting for outputs from/).parentElement).toHaveTextContent(
      "clone_repo (repo_owner, repo_name)",
    )
  })

  it("names just the block when it is waited on only for optional outputs", () => {
    render(
      <UnmetDependenciesWarning
        blockType="template"
        unmetInputDeps={[]}
        unmetOutputDeps={[{ blockId: "clone_repo", outputNames: [] }]}
      />,
    )
    const line = screen.getByText(/Waiting for outputs from/).parentElement
    expect(line).toHaveTextContent("Waiting for outputs from: clone_repo")
    expect(line).not.toHaveTextContent("(")
  })
})
