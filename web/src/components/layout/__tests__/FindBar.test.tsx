import { useState } from "react"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { FIND_ACTIVE_HIGHLIGHT, FIND_MATCH_HIGHLIGHT } from "@/lib/findInPage"
import { FIND_BAR_WAITS_ATTRIBUTE, FindBar, type FindBarHandle } from "../FindBar"

type Listener = (payload: unknown) => void

/** A preload api whose `on` records listeners, so a test can emit menu events. */
function makeApi() {
  const listeners = new Map<string, Set<Listener>>()
  const on = vi.fn((channel: string, cb: Listener) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(cb)
    return () => listeners.get(channel)?.delete(cb)
  })
  const api = { invoke: vi.fn(), on } as unknown as Parameters<typeof ApiProvider>[0]["api"]
  const find = async (action: "open" | "next" | "previous") => {
    await act(async () => {
      listeners.get("menu:find")?.forEach((cb) => cb({ action }))
    })
  }
  return { api, find }
}

/** Stand-ins for the CSS Custom Highlight API, which jsdom lacks. */
class FakeHighlight extends Set<Range> {
  priority = 0
}
let registry: Map<string, FakeHighlight>
const cssWithHighlights = CSS as unknown as { highlights?: Map<string, FakeHighlight> }

function renderPage(api: ReturnType<typeof makeApi>["api"]) {
  return render(
    <ApiProvider api={api}>
      <button type="button">Run</button>
      <p>alpha one</p>
      <p>alpha two</p>
      <FindBar />
    </ApiProvider>,
  )
}

const input = () => screen.getByRole("textbox", { name: "Find in page" })
// Not a role query: those skip what a modal has aria-hidden, and the bar
// sitting unusable behind a modal is the failure being tested.
const barMounted = () => document.querySelector('[role="search"]') !== null
const status = () => within(screen.getByRole("search")).getByRole("status")
const activeText = () => [...(registry.get(FIND_ACTIVE_HIGHLIGHT) ?? [])].map((r) => r.toString())

let scrollSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  registry = new Map()
  cssWithHighlights.highlights = registry
  vi.stubGlobal("Highlight", FakeHighlight)
  scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView")
})

afterEach(() => {
  delete cssWithHighlights.highlights
  vi.unstubAllGlobals()
  scrollSpy.mockRestore()
})

/** The element the last scrollIntoView call scrolled. */
const lastScrolled = () => scrollSpy.mock.contexts.at(-1) as Element | undefined

describe("FindBar", () => {
  it("opens with a given text and searches for it, through its handle", async () => {
    const { api } = makeApi()
    const ref = { current: null as FindBarHandle | null }
    render(
      <ApiProvider api={api}>
        <p>alpha one</p>
        <p>alpha two</p>
        <FindBar ref={ref} />
      </ApiProvider>,
    )

    act(() => ref.current?.open("alpha"))
    expect(input()).toHaveValue("alpha")
    expect(input()).toHaveFocus()
    expect(status()).toHaveTextContent("1 of 2")

    // Already open: a new text replaces the search.
    act(() => ref.current?.open("two"))
    expect(input()).toHaveValue("two")
    expect(status()).toHaveTextContent("1 of 1")

    // No text: the kept query stays, as with Find….
    act(() => ref.current?.open())
    expect(input()).toHaveValue("two")
  })

  it("is hidden until the Find menu item opens it, focused", async () => {
    const { api, find } = makeApi()
    renderPage(api)
    expect(screen.queryByRole("search")).not.toBeInTheDocument()

    await find("open")

    expect(screen.getByRole("search")).toBeInTheDocument()
    expect(input()).toHaveFocus()
  })

  it("counts matches in the page but not in the bar itself", async () => {
    const { api, find } = makeApi()
    renderPage(api)
    await find("open")

    fireEvent.change(input(), { target: { value: "alpha" } })
    expect(status()).toHaveTextContent("1 of 2")
    expect(registry.get(FIND_MATCH_HIGHLIGHT)?.size).toBe(2)
    expect(activeText()).toEqual(["alpha"])
    expect(registry.get(FIND_ACTIVE_HIGHLIGHT)?.priority).toBe(1)

    // "of" appears only in the bar's own "1 of 2".
    fireEvent.change(input(), { target: { value: "of" } })
    expect(status()).toHaveTextContent("No results")
    expect(registry.get(FIND_MATCH_HIGHLIGHT)?.size).toBe(0)
  })

  it("shows No results for text that is not on the page", async () => {
    const { api, find } = makeApi()
    renderPage(api)
    await find("open")
    fireEvent.change(input(), { target: { value: "zzz" } })
    expect(status()).toHaveTextContent("No results")
  })

  it("steps with Enter and Shift+Enter, wrapping around, and keeps focus in the input", async () => {
    const { api, find } = makeApi()
    renderPage(api)
    await find("open")
    fireEvent.change(input(), { target: { value: "alpha" } })

    fireEvent.keyDown(input(), { key: "Enter" })
    expect(status()).toHaveTextContent("2 of 2")
    expect(lastScrolled()).toBe(screen.getByText("alpha two"))
    // findInPage would have taken focus from the input here.
    expect(input()).toHaveFocus()

    fireEvent.keyDown(input(), { key: "Enter" })
    expect(status()).toHaveTextContent("1 of 2")
    expect(lastScrolled()).toBe(screen.getByText("alpha one"))

    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true })
    expect(status()).toHaveTextContent("2 of 2")
    expect(input()).toHaveFocus()
  })

  it("steps with the Find Next and Find Previous menu items and the buttons", async () => {
    const { api, find } = makeApi()
    renderPage(api)
    await find("open")
    fireEvent.change(input(), { target: { value: "alpha" } })

    await find("next")
    expect(status()).toHaveTextContent("2 of 2")
    await find("next")
    expect(status()).toHaveTextContent("1 of 2")
    await find("previous")
    expect(status()).toHaveTextContent("2 of 2")

    // Clicking a button keeps focus in the input, so typing carries on.
    for (const name of ["Previous match", "Next match", "Close find bar"]) {
      expect(fireEvent.mouseDown(screen.getByRole("button", { name }))).toBe(false)
    }

    fireEvent.click(screen.getByRole("button", { name: "Previous match" }))
    expect(status()).toHaveTextContent("1 of 2")
    fireEvent.click(screen.getByRole("button", { name: "Next match" }))
    expect(status()).toHaveTextContent("2 of 2")
    expect(activeText()).toEqual(["alpha"])
  })

  it("recounts when the page changes, keeping the current match", async () => {
    const { api, find } = makeApi()
    renderPage(api)
    await find("open")
    fireEvent.change(input(), { target: { value: "alpha" } })
    fireEvent.keyDown(input(), { key: "Enter" })
    expect(status()).toHaveTextContent("2 of 2")
    const scrolls = scrollSpy.mock.calls.length

    const p = document.createElement("p")
    p.textContent = "alpha three"
    document.body.appendChild(p)

    await waitFor(() => expect(status()).toHaveTextContent("2 of 3"))
    expect(registry.get(FIND_MATCH_HIGHLIGHT)?.size).toBe(3)
    // A recount doesn't scroll: streaming logs mustn't pull the page around.
    expect(scrollSpy.mock.calls.length).toBe(scrolls)
    p.remove()
  })

  it("closes on Escape, clearing the highlights and returning focus", async () => {
    const { api, find } = makeApi()
    renderPage(api)
    const run = screen.getByRole("button", { name: "Run" })
    run.focus()
    await find("open")
    fireEvent.change(input(), { target: { value: "alpha" } })

    fireEvent.keyDown(input(), { key: "Escape" })

    expect(screen.queryByRole("search")).not.toBeInTheDocument()
    expect(registry.size).toBe(0)
    expect(run).toHaveFocus()
  })

  it("closes with the close button", async () => {
    const { api, find } = makeApi()
    renderPage(api)
    await find("open")
    fireEvent.change(input(), { target: { value: "alpha" } })
    fireEvent.click(screen.getByRole("button", { name: "Close find bar" }))
    expect(screen.queryByRole("search")).not.toBeInTheDocument()
    expect(registry.size).toBe(0)
  })

  it("reopens with the last query selected and searched again", async () => {
    const { api, find } = makeApi()
    renderPage(api)
    await find("open")
    fireEvent.change(input(), { target: { value: "alpha" } })
    fireEvent.keyDown(input(), { key: "Escape" })

    await find("open")

    expect(input()).toHaveValue("alpha")
    expect(input()).toHaveFocus()
    const el = input() as HTMLInputElement
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 5])
    expect(status()).toHaveTextContent("1 of 2")
    expect(registry.get(FIND_MATCH_HIGHLIGHT)?.size).toBe(2)
  })

  it("opens from Find Next when closed", async () => {
    const { api, find } = makeApi()
    renderPage(api)
    await find("next")
    expect(input()).toHaveFocus()
  })

  it("refocuses the input on Find while open", async () => {
    const { api, find } = makeApi()
    renderPage(api)
    await find("open")
    screen.getByRole("button", { name: "Run" }).focus()
    await find("open")
    expect(input()).toHaveFocus()
  })

  it("closes itself when a modal dialog keeps focus", async () => {
    const { api, find } = makeApi()
    renderPage(api)
    // What a Radix modal's focus scope does: pull focus back inside itself.
    const trap = screen.getByRole("button", { name: "Run" })
    trap.focus()
    const keepFocus = (e: FocusEvent) => {
      if (e.target !== trap) trap.focus()
    }
    document.addEventListener("focusin", keepFocus)
    try {
      await find("open")
      expect(screen.queryByRole("search")).not.toBeInTheDocument()
      expect(trap).toHaveFocus()
    } finally {
      document.removeEventListener("focusin", keepFocus)
    }
  })

  it("closes when a modal dialog opens over it", async () => {
    const { api, find } = makeApi()
    // Like maximizing a block's logs, which shows them again in a dialog.
    function Page() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Maximize
          </button>
          <p>alpha one</p>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Logs</DialogTitle>
              <p>alpha in the dialog</p>
            </DialogContent>
          </Dialog>
          <FindBar />
        </>
      )
    }
    render(
      <ApiProvider api={api}>
        <Page />
      </ApiProvider>,
    )
    await find("open")
    fireEvent.change(input(), { target: { value: "alpha" } })
    expect(status()).toHaveTextContent("1 of 1")

    fireEvent.click(screen.getByRole("button", { name: "Maximize" }))

    await waitFor(() => expect(barMounted()).toBe(false))
    expect(registry.size).toBe(0)
  })

  it("waits out a modal marked to be waited out, such as the command palette", async () => {
    const { api, find } = makeApi()
    function Page() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <p>alpha one</p>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent aria-describedby={undefined} {...{ [FIND_BAR_WAITS_ATTRIBUTE]: "" }}>
              <DialogTitle>Palette</DialogTitle>
            </DialogContent>
          </Dialog>
          <FindBar />
        </>
      )
    }
    render(
      <ApiProvider api={api}>
        <Page />
      </ApiProvider>,
    )
    await find("open")
    fireEvent.change(input(), { target: { value: "alpha" } })

    fireEvent.click(screen.getByRole("button", { name: "Open" }))
    await act(async () => {})

    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement)
    expect(barMounted()).toBe(true)
    expect(activeText()).toEqual(["alpha"])
  })

  it("stays open for menus and popovers, which leave the page usable", async () => {
    const { api, find } = makeApi()
    function Page({ menu, popover }: { menu: boolean; popover: boolean }) {
      return (
        <>
          <p>alpha one</p>
          <DropdownMenu open={menu}>
            <DropdownMenuTrigger>Download</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>Raw</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover open={popover}>
            <PopoverTrigger>Region</PopoverTrigger>
            <PopoverContent>
              <button type="button">us-east-1</button>
            </PopoverContent>
          </Popover>
          <FindBar />
        </>
      )
    }
    const { rerender } = render(
      <ApiProvider api={api}>
        <Page menu={false} popover={false} />
      </ApiProvider>,
    )
    await find("open")
    fireEvent.change(input(), { target: { value: "alpha" } })

    // A menu hides the rest of the page while it is open, but isn't a dialog.
    rerender(
      <ApiProvider api={api}>
        <Page menu popover={false} />
      </ApiProvider>,
    )
    await waitFor(() => expect(screen.getByRole("menu", { hidden: true })).toBeInTheDocument())
    // A popover is a dialog, but not a modal one.
    rerender(
      <ApiProvider api={api}>
        <Page menu={false} popover />
      </ApiProvider>,
    )
    screen.getByRole("button", { name: "us-east-1" }).focus()
    await act(async () => {})

    expect(barMounted()).toBe(true)
    expect(status()).toHaveTextContent("1 of 1")
  })

  it("still counts matches without the Highlight API", async () => {
    delete cssWithHighlights.highlights
    vi.unstubAllGlobals()
    const { api, find } = makeApi()
    renderPage(api)
    await find("open")
    fireEvent.change(input(), { target: { value: "alpha" } })
    expect(status()).toHaveTextContent("1 of 2")
    fireEvent.keyDown(input(), { key: "Enter" })
    expect(status()).toHaveTextContent("2 of 2")
    fireEvent.keyDown(input(), { key: "Escape" })
    expect(screen.queryByRole("search")).not.toBeInTheDocument()
  })
})
