import { describe, it, expect, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../../ui/dropdown-menu"
import { RunbookLayoutProvider } from "@/contexts/RunbookLayoutContext"
import { RUNBOOK_LAYOUT_STORAGE_KEY } from "@/contexts/RunbookLayoutContext.types"
import { RunbookLayoutToggle } from "../RunbookLayoutToggle"

/** The Header's Menu, open, with only the runbook width picker in it. */
function renderMenu() {
  render(
    <RunbookLayoutProvider>
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <RunbookLayoutToggle />
        </DropdownMenuContent>
      </DropdownMenu>
    </RunbookLayoutProvider>,
  )
}

describe("RunbookLayoutToggle", () => {
  beforeEach(() => localStorage.clear())

  it("offers Fixed and Fill window, with Fixed picked by default", () => {
    renderMenu()
    expect(screen.getByText("Runbook width")).toBeInTheDocument()
    expect(screen.getByRole("menuitemradio", { name: "Fixed" })).toBeChecked()
    expect(screen.getByRole("menuitemradio", { name: "Fill window" })).not.toBeChecked()
  })

  it("saves the picked width", async () => {
    renderMenu()
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Fill window" }))
    expect(localStorage.getItem(RUNBOOK_LAYOUT_STORAGE_KEY)).toBe("fill")
  })

  it("shows the saved width as picked", () => {
    localStorage.setItem(RUNBOOK_LAYOUT_STORAGE_KEY, "fill")
    renderMenu()
    expect(screen.getByRole("menuitemradio", { name: "Fill window" })).toBeChecked()
  })
})
