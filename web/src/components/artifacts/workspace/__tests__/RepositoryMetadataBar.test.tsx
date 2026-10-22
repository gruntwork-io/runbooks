import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import type { PathRoots } from "@/lib/displayPath"
import { ShortenedPaths } from "@/test/ShortenedPaths"
import { RepositoryMetadataBar } from "../RepositoryMetadataBar"

function renderBar(localPath: string, roots: PathRoots) {
  render(
    <ShortenedPaths roots={roots}>
      <RepositoryMetadataBar gitInfo={null} localPath={localPath} />
    </ShortenedPaths>,
  )
}

describe("RepositoryMetadataBar", () => {
  it("shows a clone in the session's directory under session/, with the full path on hover", () => {
    renderBar("/sessions/0199a5c2/infra", { sessionDir: "/sessions/0199a5c2" })

    expect(screen.getByText("session/infra")).toHaveAttribute("title", "/sessions/0199a5c2/infra")
  })

  it("shows a checkout elsewhere where it is, not under the session's name", () => {
    // The backend resolves the checkout with Node's path module, which uses '\' on Windows.
    renderBar("C:\\Users\\me\\infra", {
      sessionDir: "C:\\Users\\me\\AppData\\Roaming\\Runbooks\\v0\\sessions\\dirs\\0199a5c2",
      homeDir: "C:\\Users\\me",
    })

    expect(screen.getByText("~\\infra")).toBeInTheDocument()
  })
})
