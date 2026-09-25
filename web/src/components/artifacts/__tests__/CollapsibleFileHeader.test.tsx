import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { CollapsibleFileHeader } from "../CollapsibleFileHeader"

function renderHeader() {
  const onToggle = vi.fn()
  render(
    <CollapsibleFileHeader
      isCollapsed={false}
      onToggle={onToggle}
      path="modules/vpc/main.tf"
      icon={null}
      trailing={null}
    />,
  )
  const header = screen.getByText("modules/vpc/main.tf").closest('[role="button"]') as HTMLElement
  return { onToggle, header, copyButton: screen.getByTitle("Copy file path") }
}

describe("CollapsibleFileHeader keyboard toggle", () => {
  it.each(["Enter", " "])("toggles on %j pressed on the header", (key) => {
    const { onToggle, header } = renderHeader()

    fireEvent.keyDown(header, { key })

    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it.each(["Enter", " "])("does not toggle on %j pressed on the copy button", (key) => {
    const { onToggle, copyButton } = renderHeader()

    fireEvent.keyDown(copyButton, { key })

    expect(onToggle).not.toHaveBeenCalled()
  })

  it("prevents Space's default so the pane does not scroll", () => {
    const { header } = renderHeader()

    // fireEvent returns false when a handler called preventDefault.
    expect(fireEvent.keyDown(header, { key: " " })).toBe(false)
  })
})
