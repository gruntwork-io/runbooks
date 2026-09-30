import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CloneResultDisplay } from "../CloneResult"

const CLONED = { fileCount: 3, relativePath: "infra", absolutePath: "/work/infra" }

describe("CloneResultDisplay — repository path", () => {
  it("shows only the relative path, with the absolute path on hover", () => {
    render(<CloneResultDisplay result={CLONED} onCloneAgain={vi.fn()} />)

    expect(screen.getByText("Local path:")).toBeInTheDocument()
    expect(screen.getByText("infra")).toHaveAttribute("title", "/work/infra")
    // The absolute path is not printed as a second row.
    expect(screen.queryByText("/work/infra")).not.toBeInTheDocument()
    expect(screen.queryByText(/Relative:|Absolute:/)).not.toBeInTheDocument()
  })

  it("copies the absolute path from the single copy button", async () => {
    // setup() installs user-event's clipboard stub, so the real copy helper runs.
    const user = userEvent.setup()
    render(<CloneResultDisplay result={CLONED} onCloneAgain={vi.fn()} />)

    const copyButtons = screen.getAllByRole("button", { name: /Copy full path/i })
    expect(copyButtons).toHaveLength(1)
    expect(copyButtons[0]).toHaveAttribute("title", "Copy full path: /work/infra")

    await user.click(copyButtons[0])

    expect(await navigator.clipboard.readText()).toBe("/work/infra")
  })

  it("shows a checkout outside the working directory once, by its absolute path", async () => {
    const user = userEvent.setup()
    // The domain layer returns the absolute path for both fields when the
    // checkout has no relative form.
    const outside = { fileCount: 42, relativePath: "/home/me/infra", absolutePath: "/home/me/infra" }
    render(<CloneResultDisplay result={outside} source="local" onCloneAgain={vi.fn()} />)

    expect(screen.getByText("Repository path:")).toBeInTheDocument()
    expect(screen.getAllByText("/home/me/infra")).toHaveLength(1)

    await user.click(screen.getByRole("button", { name: /Copy full path/i }))

    expect(await navigator.clipboard.readText()).toBe("/home/me/infra")
  })
})
