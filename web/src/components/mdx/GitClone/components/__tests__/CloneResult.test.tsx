import { describe, it, expect, vi } from "vitest"
import type { ComponentProps } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ShortenedPaths } from "@/test/ShortenedPaths"
import { CloneResultDisplay } from "../CloneResult"

const CLONED = { fileCount: 3, relativePath: "infra", absolutePath: "/work/infra" }

/** Render in a session whose directory is /work, for a user whose home is /home/me. */
function renderResult(props: Omit<ComponentProps<typeof CloneResultDisplay>, "onCloneAgain">) {
  const roots = { sessionDir: "/work", homeDir: "/home/me" }
  render(
    <ShortenedPaths roots={roots}>
      <CloneResultDisplay {...props} onCloneAgain={vi.fn()} />
    </ShortenedPaths>,
  )
}

describe("CloneResultDisplay — repository path", () => {
  it("shows the path shortened, with the full path on hover", () => {
    renderResult({ result: CLONED })

    expect(screen.getByText("Local path:")).toBeInTheDocument()
    expect(screen.getByText("session/infra")).toHaveAttribute("title", "/work/infra")
    // The full path is not printed as a second row.
    expect(screen.queryByText("/work/infra")).not.toBeInTheDocument()
    expect(screen.queryByText(/Relative:|Absolute:/)).not.toBeInTheDocument()
  })

  it("copies the full path from the single copy button", async () => {
    // setup() installs user-event's clipboard stub, so the real copy helper runs.
    const user = userEvent.setup()
    renderResult({ result: CLONED })

    const copyButtons = screen.getAllByRole("button", { name: /Copy full path/i })
    expect(copyButtons).toHaveLength(1)
    expect(copyButtons[0]).toHaveAttribute("title", "Copy full path: /work/infra")

    await user.click(copyButtons[0]!)

    expect(await navigator.clipboard.readText()).toBe("/work/infra")
  })

  it("shows a checkout outside the session's directory under ~, once", async () => {
    const user = userEvent.setup()
    // The domain layer returns the absolute path for both fields when the
    // checkout has no relative form.
    const outside = {
      fileCount: 42,
      relativePath: "/home/me/infra",
      absolutePath: "/home/me/infra",
    }
    renderResult({ result: outside, source: "local" })

    expect(screen.getByText("Repository path:")).toBeInTheDocument()
    expect(screen.getAllByText("~/infra")).toHaveLength(1)

    await user.click(screen.getByRole("button", { name: /Copy full path/i }))

    expect(await navigator.clipboard.readText()).toBe("/home/me/infra")
  })
})
