import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SessionDirButton } from "../SessionDirButton"

const DIR = "/Users/me/Library/Application Support/Runbooks/v0/sessions/dirs/0199a5c2"

describe("SessionDirButton", () => {
  it("copies the session's directory when clicked", async () => {
    const user = userEvent.setup()
    render(<SessionDirButton dir={DIR} />)

    await user.click(screen.getByRole("button", { name: "Copy session directory" }))

    expect(await navigator.clipboard.readText()).toBe(DIR)
  })

  it("shows the directory on hover, with a button that copies it too", async () => {
    const user = userEvent.setup()
    render(<SessionDirButton dir={DIR} />)

    await user.hover(screen.getByRole("button", { name: "Copy session directory" }))
    const tooltip = await screen.findByRole("tooltip")
    expect(tooltip).toHaveTextContent(DIR)

    await navigator.clipboard.writeText("something else")
    const [, inTooltip] = screen.getAllByRole("button", { name: "Copy session directory" })
    await user.click(inTooltip!)

    expect(await navigator.clipboard.readText()).toBe(DIR)
  })
})
