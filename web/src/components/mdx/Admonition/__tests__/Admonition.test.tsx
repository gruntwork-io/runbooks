import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
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

  describe("confirming", () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
      localStorage.clear()
    })

    it("disables the confirmation button, then fades out and hides the admonition", () => {
      renderAdmonition({ type: "danger", title: "Destructive", confirmationText: "I understand" })
      const button = screen.getByRole("button", { name: "I understand" })

      fireEvent.click(button)
      expect(button).toBeDisabled()
      expect(screen.getByText("Destructive")).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(1250)
      })
      expect(screen.queryByText("Destructive")).not.toBeInTheDocument()
    })

    it("saves the \"Don't show me this again\" preference when confirmed", () => {
      renderAdmonition({
        type: "warning",
        confirmationText: "Got it",
        allowPermanentHide: true,
        storageKey: "confirm-test",
      })

      fireEvent.click(screen.getByLabelText("Don't show me this again"))
      fireEvent.click(screen.getByRole("button", { name: "Got it" }))

      expect(localStorage.getItem("admonition_hide_confirm-test")).toBe("true")
    })
  })

  // --- Invalid type ---

  it("shows error for invalid admonition type", () => {
    renderAdmonition({ type: "invalid" as any })
    expect(screen.getByText(/Invalid Admonition Type/)).toBeInTheDocument()
  })
})
