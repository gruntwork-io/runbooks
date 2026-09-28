import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { RepositoryMetadataBar } from "../RepositoryMetadataBar"

describe("RepositoryMetadataBar", () => {
  it("names a Windows checkout by its folder, not its full path", () => {
    // The backend resolves the checkout with Node's path module, which uses '\' on Windows.
    render(<RepositoryMetadataBar gitInfo={null} localPath={"C:\\Users\\me\\infra"} />)
    expect(screen.getByText("./infra")).toBeInTheDocument()
  })
})
