import { describe, it, expect } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { FolderOpen } from "lucide-react"
import { CopyIconButton } from "../CopyIconButton"

const DIR = "/Users/me/Library/Application Support/Runbooks/v0/sessions/dirs/0199a5c2"

function renderButton() {
  render(
    <CopyIconButton
      value={DIR}
      icon={FolderOpen}
      label="Copy session directory"
      copiedLabel="Session directory copied"
    />,
  )
  return screen.getByRole("button", { name: "Copy session directory" })
}

describe("CopyIconButton", () => {
  it("says what it copies on hover, without showing the value", async () => {
    const user = userEvent.setup()
    const button = renderButton()

    await user.hover(button)

    const tooltip = await screen.findByRole("tooltip")
    expect(tooltip).toHaveTextContent("Copy session directory")
    expect(tooltip).not.toHaveTextContent(DIR)
  })

  it("copies the value, and says so for a moment after the pointer has left", async () => {
    const user = userEvent.setup()
    const button = renderButton()

    await user.click(button)
    await user.unhover(button)

    expect(await navigator.clipboard.readText()).toBe(DIR)
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Session directory copied")
    await waitFor(
      () => expect(screen.queryByText("Session directory copied")).not.toBeInTheDocument(),
      { timeout: 3000 },
    )
  })
})
