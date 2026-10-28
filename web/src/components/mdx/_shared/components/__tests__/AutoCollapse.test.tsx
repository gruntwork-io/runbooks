import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AutoCollapse, CollapseButton } from "../AutoCollapse"

function Block({
  enabled = true,
  done,
  warn,
}: {
  enabled?: boolean
  done: boolean
  warn?: boolean
}) {
  return (
    <AutoCollapse enabled={enabled} done={done} warn={warn} id="deploy" title="**Deploy** the app">
      <div data-testid="deploy">
        <CollapseButton />
        <input aria-label="Note" />
      </div>
    </AutoCollapse>
  )
}

const bar = () => screen.queryByTestId("deploy-collapsed")
const expandButton = () => screen.getByRole("button", { name: "Deploy the app", expanded: false })
const collapseButton = () => screen.queryByRole("button", { name: "Collapse block" })

describe("AutoCollapse", () => {
  it("shows a done block in full without autoCollapse", () => {
    render(<Block enabled={false} done />)
    expect(screen.getByTestId("deploy")).toBeVisible()
    expect(bar()).toBeNull()
    expect(collapseButton()).toBeNull()
  })

  it("shows a block in full while it isn't done", () => {
    render(<Block done={false} />)
    expect(screen.getByTestId("deploy")).toBeVisible()
    expect(bar()).toBeNull()
    expect(collapseButton()).toBeNull()
  })

  it("starts folded into a bar with its title when it's done on mount", () => {
    render(<Block done />)
    expect(bar()).toHaveTextContent("Deploy the app")
    expect(screen.getByText("Deploy").tagName).toBe("STRONG")
    expect(screen.getByTestId("deploy")).not.toBeVisible()
  })

  it("folds once it becomes done, keeping what was entered in it", async () => {
    const { rerender } = render(<Block done={false} />)
    await userEvent.type(screen.getByRole("textbox", { name: "Note" }), "staging")

    rerender(<Block done />)
    expect(bar()).toBeInTheDocument()
    expect(screen.getByTestId("deploy")).not.toBeVisible()

    await userEvent.click(expandButton())
    expect(screen.getByRole("textbox", { name: "Note" })).toHaveValue("staging")
  })

  it("expands from its bar and folds again from the collapse button", async () => {
    render(<Block done />)

    await userEvent.click(expandButton())
    expect(bar()).toBeNull()
    expect(screen.getByTestId("deploy")).toBeVisible()

    await userEvent.click(collapseButton()!)
    expect(bar()).toBeInTheDocument()
    expect(screen.getByTestId("deploy")).not.toBeVisible()
  })

  it("expands when it's no longer done, and folds again once it's done again", async () => {
    const { rerender } = render(<Block done />)
    await userEvent.click(expandButton())

    rerender(<Block done={false} />)
    expect(screen.getByTestId("deploy")).toBeVisible()
    expect(collapseButton()).toBeNull()

    rerender(<Block done />)
    expect(bar()).toBeInTheDocument()
  })

  it("shows a folded block that is done in full once it's no longer done", () => {
    const { rerender } = render(<Block done />)
    rerender(<Block done={false} />)
    expect(bar()).toBeNull()
    expect(screen.getByTestId("deploy")).toBeVisible()
  })

  it("shows a warning bar for a block done with a warning", () => {
    render(<Block done warn />)
    expect(bar()).toHaveClass("bg-warning-muted")
  })
})
