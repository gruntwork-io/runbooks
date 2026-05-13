import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import { Admonition } from "../Admonition"

function renderAdmonition(props: Partial<React.ComponentProps<typeof Admonition>> = {}) {
  return render(
    <TestWrapper>
      <Admonition type="note" {...props} />
    </TestWrapper>,
  )
}

describe("Admonition", () => {
  // --- Type rendering ---

  it("renders note type", () => {
    renderAdmonition({ type: "note", title: "Note Title" })
    expect(screen.getByText("Note Title")).toBeInTheDocument()
  })

  it("renders info type", () => {
    renderAdmonition({ type: "info", title: "Info Title" })
    expect(screen.getByText("Info Title")).toBeInTheDocument()
  })

  it("renders warning type", () => {
    renderAdmonition({ type: "warning", title: "Warning Title" })
    expect(screen.getByText("Warning Title")).toBeInTheDocument()
  })

  it("renders danger type", () => {
    renderAdmonition({ type: "danger", title: "Danger Title" })
    expect(screen.getByText("Danger Title")).toBeInTheDocument()
  })

  it("uses default title when none provided", () => {
    renderAdmonition({ type: "note" })
    expect(screen.getByText("Note")).toBeInTheDocument()
  })

  // --- Description ---

  it("renders description text", () => {
    renderAdmonition({ type: "info", description: "Some helpful info" })
    expect(screen.getByText("Some helpful info")).toBeInTheDocument()
  })

  it("renders children content", () => {
    render(
      <TestWrapper>
        <Admonition type="note">
          <p>Child content here</p>
        </Admonition>
      </TestWrapper>,
    )
    expect(screen.getByText("Child content here")).toBeInTheDocument()
  })

  // --- Closable ---

  it("shows close button when closable", () => {
    renderAdmonition({ type: "warning", closable: true })
    expect(screen.getByLabelText("Close")).toBeInTheDocument()
  })

  it("hides admonition when close is clicked", async () => {
    renderAdmonition({ type: "warning", title: "Closable", closable: true })
    expect(screen.getByText("Closable")).toBeInTheDocument()

    await userEvent.click(screen.getByLabelText("Close"))
    expect(screen.queryByText("Closable")).not.toBeInTheDocument()
  })

  it("does not show close button when not closable", () => {
    renderAdmonition({ type: "note" })
    expect(screen.queryByLabelText("Close")).not.toBeInTheDocument()
  })

  // --- Confirmation text ---

  it("shows confirmation button when confirmationText is set", () => {
    renderAdmonition({ type: "danger", confirmationText: "I understand" })
    expect(screen.getByText("I understand")).toBeInTheDocument()
  })

  // --- Invalid type ---

  it("shows error for invalid admonition type", () => {
    renderAdmonition({ type: "invalid" as any })
    expect(screen.getByText(/Invalid Admonition Type/)).toBeInTheDocument()
  })
})
