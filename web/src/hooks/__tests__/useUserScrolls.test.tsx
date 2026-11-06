import { useState } from "react"
import { describe, it, expect, vi, afterEach } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { USER_SCROLL_WINDOW_MS, useUserScrolls } from "../useUserScrolls"
import type { FilesScroll } from "@/lib/fileReview"

function Page({ onScroll }: { onScroll: (scroll: FilesScroll) => void }) {
  const [pane, setPane] = useState<HTMLDivElement | null>(null)
  useUserScrolls(pane, onScroll)
  return (
    <>
      <div ref={setPane} data-testid="pane">
        <button>Inside</button>
      </div>
      <input aria-label="Field" />
      <button>Elsewhere</button>
    </>
  )
}

function setUp() {
  const onScroll = vi.fn()
  render(<Page onScroll={onScroll} />)
  const pane = screen.getByTestId("pane")
  Object.defineProperty(pane, "scrollTop", { value: 0, writable: true, configurable: true })
  const scrollTo = (top: number) => {
    pane.scrollTop = top
    fireEvent.scroll(pane)
  }
  return { onScroll, pane, scrollTo }
}

describe("useUserScrolls", () => {
  afterEach(() => vi.restoreAllMocks())

  it("reports a scroll made with the wheel, from where the last scroll left the element", () => {
    const { onScroll, pane, scrollTo } = setUp()
    scrollTo(50)
    expect(onScroll).not.toHaveBeenCalled()

    fireEvent.wheel(pane)
    scrollTo(120)
    expect(onScroll).toHaveBeenCalledWith({ from: 50, to: 120 })
  })

  it("reports scrolls by key, but not keys typed in a field or that press a button", () => {
    const { onScroll, scrollTo } = setUp()
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Field" }), { key: "ArrowDown" })
    scrollTo(10)
    fireEvent.keyDown(screen.getByRole("button", { name: "Inside" }), { key: " " })
    scrollTo(20)
    expect(onScroll).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByRole("button", { name: "Inside" }), { key: "PageDown" })
    scrollTo(110)
    expect(onScroll).toHaveBeenCalledWith({ from: 20, to: 110 })
  })

  it("reports scrolls while the scrollbar is dragged", () => {
    const { onScroll, pane, scrollTo } = setUp()
    fireEvent.pointerDown(pane)
    scrollTo(300)
    expect(onScroll).toHaveBeenCalledWith({ from: 0, to: 300 })
  })

  it("stops reporting scrolls after a click elsewhere, or a while after the wheel", () => {
    const { onScroll, pane, scrollTo } = setUp()
    fireEvent.wheel(pane)
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }))
    scrollTo(100)
    expect(onScroll).not.toHaveBeenCalled()

    const now = performance.now()
    vi.spyOn(performance, "now").mockReturnValue(now)
    fireEvent.wheel(pane)
    vi.spyOn(performance, "now").mockReturnValue(now + USER_SCROLL_WINDOW_MS + 1)
    scrollTo(200)
    expect(onScroll).not.toHaveBeenCalled()
  })
})
