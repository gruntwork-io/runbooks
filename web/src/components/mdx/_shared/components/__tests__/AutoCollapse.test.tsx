import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AutoCollapse, CollapseButton, WhenFolded } from "../AutoCollapse"

// A block laid out as the real ones are: its header marked with data-fold
function Block({ enabled = true, done }: { enabled?: boolean; done: boolean }) {
  return (
    <AutoCollapse enabled={enabled} done={done}>
      <div data-fold="path" data-testid="deploy">
        <div data-fold="keep">
          <CollapseButton />
        </div>
        <div data-fold="path">
          <div data-fold="title">Deploy the app</div>
          <WhenFolded>
            <div data-fold="title">./deploy.sh</div>
          </WhenFolded>
          <input aria-label="Note" />
        </div>
        <div>Logs</div>
      </div>
    </AutoCollapse>
  )
}

const note = () => screen.getByLabelText("Note")
const expandButton = () => screen.queryByRole("button", { name: "Expand block", expanded: false })
const collapseButton = () =>
  screen.queryByRole("button", { name: "Collapse block", expanded: true })

function expectFolded() {
  expect(screen.getByText("Deploy the app")).toBeVisible()
  expect(note()).not.toBeVisible()
  expect(screen.getByText("Logs")).not.toBeVisible()
  expect(expandButton()).toBeInTheDocument()
}

function expectInFull() {
  expect(screen.getByText("Deploy the app")).toBeVisible()
  expect(note()).toBeVisible()
  expect(screen.getByText("Logs")).toBeVisible()
  expect(expandButton()).toBeNull()
}

describe("AutoCollapse", () => {
  it("shows a done block in full without autoCollapse", () => {
    render(<Block enabled={false} done />)
    expectInFull()
    expect(collapseButton()).toBeNull()
  })

  it("shows a block in full while it isn't done", () => {
    render(<Block done={false} />)
    expectInFull()
    expect(collapseButton()).toBeNull()
  })

  it("starts folded down to its header when it's done on mount", () => {
    render(<Block done />)
    expectFolded()
  })

  it("folds once it becomes done, keeping what was entered in it", async () => {
    const { rerender } = render(<Block done={false} />)
    await userEvent.type(note(), "staging")

    rerender(<Block done />)
    expectFolded()

    await userEvent.click(expandButton()!)
    expect(note()).toHaveValue("staging")
  })

  it("expands from its button and folds again from it", async () => {
    render(<Block done />)

    await userEvent.click(expandButton()!)
    expectInFull()

    await userEvent.click(collapseButton()!)
    expectFolded()
  })

  it("expands on a click anywhere on it while folded, and only then", async () => {
    render(<Block done />)

    await userEvent.click(screen.getByText("Deploy the app"))
    expectInFull()

    await userEvent.click(screen.getByText("Deploy the app"))
    expectInFull()
  })

  it("shows what only a folded block shows, only while folded", async () => {
    render(<Block done />)
    expect(screen.getByText("./deploy.sh")).toBeVisible()

    await userEvent.click(expandButton()!)
    expect(screen.queryByText("./deploy.sh")).toBeNull()
  })

  it("shows in full once it's no longer done, and folds again once it's done again", async () => {
    const { rerender } = render(<Block done />)
    await userEvent.click(expandButton()!)

    rerender(<Block done={false} />)
    expectInFull()
    expect(collapseButton()).toBeNull()

    rerender(<Block done />)
    expectFolded()
  })
})
