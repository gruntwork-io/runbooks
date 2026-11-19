import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { ViewLogs } from "../ViewLogs"
import { FindBar } from "@/components/layout/FindBar"
import { ApiProvider } from "@/contexts/ApiContext"
import type { LogEntry } from "@/hooks/useApiExec"
import { LOG_ACTIVE_HIGHLIGHT, LOG_MATCH_HIGHLIGHT } from "@/lib/logSearch"
import { makeTestApi } from "@/test/test-api"

function entry(line: string): LogEntry {
  return { line, timestamp: "2026-01-01T00:00:00.000Z" }
}

/** A failed apply: three NAT gateway lines, one of them in color. */
const APPLY = [
  "aws_nat_gateway.main[0]: Creating...",
  "\u001b[32maws_nat_gateway.main[0]: Creation complete after 1m42s\u001b[0m",
  "aws_route_table.private: Creating...",
  "Error: creating aws_nat_gateway.main[2]: NatGatewayLimitExceeded",
].map(entry)

/** Stand-ins for the CSS Custom Highlight API, which jsdom lacks. */
class FakeHighlight extends Set<Range> {
  priority = 0
}
let registry: Map<string, FakeHighlight>
const cssWithHighlights = CSS as unknown as { highlights?: Map<string, FakeHighlight> }

beforeEach(() => {
  registry = new Map()
  cssWithHighlights.highlights = registry
  vi.stubGlobal("Highlight", FakeHighlight)
})

afterEach(() => {
  delete cssWithHighlights.highlights
  vi.unstubAllGlobals()
})

type Props = Partial<ComponentProps<typeof ViewLogs>>

function renderLogs(props: Props = {}) {
  const view = (next: Props) => (
    <ViewLogs logs={APPLY} status="fail" blockId="apply-vpc" autoOpen {...props} {...next} />
  )
  const result = render(view({}))
  return { ...result, rerenderLogs: (next: Props) => result.rerender(view(next)) }
}

/**
 * The logs on a page with the find bar, and a way to send the Edit menu's
 * find items as the real menu would.
 */
function renderWithFindBar(props: Props = {}) {
  const testApi = makeTestApi()
  render(
    <ApiProvider api={testApi.api}>
      <button type="button">Elsewhere</button>
      <ViewLogs logs={APPLY} status="fail" blockId="apply-vpc" autoOpen {...props} />
      <FindBar />
    </ApiProvider>,
  )
  const find = async (action: "open" | "next" | "previous") => {
    await act(async () => {
      testApi.emit("menu:find", { action })
    })
  }
  return { find }
}

const logInput = () => screen.getByRole("textbox", { name: "Find in logs" })
const logStatus = () =>
  within(screen.getByRole("search", { name: "Search logs" })).getByRole("status")
const logBody = () => screen.getByRole("region", { name: "Log output" })
const painted = (name: string) => [...(registry.get(name) ?? [])].map((r) => r.toString())

describe("ViewLogs search", () => {
  it("opens from the search button, expanding the logs, and counts matches in the log text only", async () => {
    const user = userEvent.setup()
    renderLogs({ autoOpen: false })
    expect(screen.getByRole("button", { name: "View Logs" })).toHaveAttribute(
      "aria-expanded",
      "false",
    )

    await user.click(screen.getByRole("button", { name: "Search logs" }))
    expect(screen.getByRole("button", { name: "View Logs" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    expect(logInput()).toHaveFocus()
    expect(screen.getByRole("button", { name: "Search logs" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )

    await user.type(logInput(), "nat_gateway")
    // Without layout, the search starts at the end of the log.
    expect(logStatus()).toHaveTextContent("3 of 3")
    expect(painted(LOG_MATCH_HIGHLIGHT)).toEqual(["nat_gateway", "nat_gateway", "nat_gateway"])
    expect(painted(LOG_ACTIVE_HIGHLIGHT)).toEqual(["nat_gateway"])
    expect(registry.get(LOG_ACTIVE_HIGHLIGHT)?.priority).toBe(1)

    // Timestamps aren't log text.
    const time = new Date(APPLY[0]!.timestamp).toLocaleTimeString()
    expect(screen.getAllByText(time).length).toBeGreaterThan(0)
    await user.clear(logInput())
    await user.type(logInput(), time)
    expect(logStatus()).toHaveTextContent("No results")
    expect(painted(LOG_MATCH_HIGHLIGHT)).toEqual([])
  })

  it("steps with Enter, Shift+Enter and the buttons, wrapping around", async () => {
    const user = userEvent.setup()
    renderLogs()
    await user.click(screen.getByRole("button", { name: "Search logs" }))
    await user.type(logInput(), "creat")
    expect(logStatus()).toHaveTextContent("4 of 4")

    await user.keyboard("{Enter}")
    expect(logStatus()).toHaveTextContent("1 of 4")
    await user.keyboard("{Shift>}{Enter}{/Shift}")
    expect(logStatus()).toHaveTextContent("4 of 4")
    await user.click(screen.getByRole("button", { name: "Previous match" }))
    expect(logStatus()).toHaveTextContent("3 of 4")
    await user.click(screen.getByRole("button", { name: "Next match" }))
    expect(logStatus()).toHaveTextContent("4 of 4")
    // The buttons leave focus in the input, so typing carries on.
    expect(logInput()).toHaveFocus()

    // A longer query carries on from the current match.
    await user.keyboard("{Enter}{Enter}")
    expect(logStatus()).toHaveTextContent("2 of 4")
    await user.type(logInput(), "ion")
    expect(logStatus()).toHaveTextContent("1 of 1")
    expect(painted(LOG_ACTIVE_HIGHLIGHT)).toEqual(["Creation"])
  })

  it("matches case and regular expressions, keeping the last results while a regex doesn't parse", async () => {
    const user = userEvent.setup()
    renderLogs()
    await user.click(screen.getByRole("button", { name: "Search logs" }))
    await user.type(logInput(), "error")
    expect(logStatus()).toHaveTextContent("1 of 1")

    await user.click(screen.getByRole("button", { name: "Match case" }))
    expect(screen.getByRole("button", { name: "Match case" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    expect(logStatus()).toHaveTextContent("No results")
    await user.keyboard("{Alt>}c{/Alt}")
    expect(logStatus()).toHaveTextContent("1 of 1")

    await user.keyboard("{Alt>}r{/Alt}")
    expect(screen.getByRole("button", { name: "Use regular expression" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await user.clear(logInput())
    // Pasted: user.type reads "[" as the start of a key name.
    await user.paste("main\\[\\d\\]")
    expect(logStatus()).toHaveTextContent("3 of 3")
    expect(painted(LOG_MATCH_HIGHLIGHT)).toEqual(["main[0]", "main[0]", "main[2]"])

    // One more "(" doesn't parse: the last results stay.
    await user.type(logInput(), "(")
    expect(logStatus()).toHaveTextContent("Invalid regex")
    expect(logInput()).toHaveAttribute("aria-invalid", "true")
    expect(painted(LOG_MATCH_HIGHLIGHT)).toHaveLength(3)
    await user.type(logInput(), ")")
    expect(logStatus()).toHaveTextContent("3 of 3")
    expect(logInput()).not.toHaveAttribute("aria-invalid")
  })

  it("shows only the matching lines, with how many of the lines show", async () => {
    const user = userEvent.setup()
    renderLogs()
    await user.click(screen.getByRole("button", { name: "Search logs" }))
    await user.type(logInput(), "nat_gateway")
    await user.keyboard("{Alt>}l{/Alt}")

    expect(screen.getByRole("button", { name: "Show only matching lines" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    expect(screen.getByText("Showing 3 of 4 lines")).toBeInTheDocument()
    expect(screen.queryByText("aws_route_table.private: Creating...")).not.toBeInTheDocument()

    await user.clear(logInput())
    await user.type(logInput(), "nothing like this")
    expect(screen.getByText("Showing 0 of 4 lines")).toBeInTheDocument()
    expect(screen.getByText("No matching lines.")).toBeInTheDocument()

    // A closed search shows the whole log again.
    await user.keyboard("{Escape}")
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument()
    expect(screen.getByText("aws_route_table.private: Creating...")).toBeInTheDocument()
  })

  it("counts matching lines as they stream in, keeping the current match", async () => {
    const user = userEvent.setup()
    const { rerenderLogs } = renderLogs({ logs: APPLY.slice(0, 2), status: "running" })
    await user.click(screen.getByRole("button", { name: "Search logs" }))
    await user.click(logInput())
    await user.paste("main[0]")
    await user.keyboard("{Enter}")
    expect(logStatus()).toHaveTextContent("1 of 2")

    rerenderLogs({ logs: [...APPLY, entry("Retrying aws_nat_gateway.main[0]")], status: "running" })
    expect(logStatus()).toHaveTextContent("1 of 3")
    expect(painted(LOG_MATCH_HIGHLIGHT)).toHaveLength(3)
  })

  it("closes on Escape, returning focus to the log, and reopens with the query selected", async () => {
    const user = userEvent.setup()
    renderLogs()
    await user.click(screen.getByRole("button", { name: "Search logs" }))
    await user.type(logInput(), "creat")

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("search", { name: "Search logs" })).not.toBeInTheDocument()
    expect(logBody()).toHaveFocus()
    expect(painted(LOG_MATCH_HIGHLIGHT)).toEqual([])

    await user.click(screen.getByRole("button", { name: "Search logs" }))
    expect(logInput()).toHaveValue("creat")
    expect(logInput()).toHaveFocus()
    expect(logStatus()).toHaveTextContent("4 of 4")
    await user.keyboard("route")
    expect(logInput()).toHaveValue("route")
  })

  it("closes when the logs collapse", async () => {
    const user = userEvent.setup()
    renderLogs()
    await user.click(screen.getByRole("button", { name: "Search logs" }))
    await user.type(logInput(), "creat")

    await user.click(screen.getByRole("button", { name: "View Logs" }))
    await user.click(screen.getByRole("button", { name: "View Logs" }))
    expect(screen.queryByRole("search", { name: "Search logs" })).not.toBeInTheDocument()
    expect(painted(LOG_MATCH_HIGHLIGHT)).toEqual([])
  })
})

describe("ViewLogs and the Edit menu's Find items", () => {
  it("takes Find… and Find Next while the logs have focus, leaving the rest to the find bar", async () => {
    const user = userEvent.setup()
    const { find } = renderWithFindBar()

    logBody().focus()
    await find("open")
    expect(logInput()).toHaveFocus()
    expect(screen.queryByRole("textbox", { name: "Find in page" })).not.toBeInTheDocument()

    await user.type(logInput(), "creat")
    expect(logStatus()).toHaveTextContent("4 of 4")
    await find("next")
    expect(logStatus()).toHaveTextContent("1 of 4")
    await find("previous")
    expect(logStatus()).toHaveTextContent("4 of 4")

    screen.getByRole("button", { name: "Elsewhere" }).focus()
    await find("open")
    expect(screen.getByRole("textbox", { name: "Find in page" })).toHaveFocus()
  })

  it("opens a collapsed log's search from its header", async () => {
    const { find } = renderWithFindBar({ autoOpen: false })
    screen.getByRole("button", { name: "View Logs" }).focus()
    await find("open")
    expect(screen.getByRole("button", { name: "View Logs" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
    expect(logInput()).toHaveFocus()
  })

  it("searches maximized logs, where Escape closes the search before the logs", async () => {
    const user = userEvent.setup()
    const { find } = renderWithFindBar()
    await user.click(screen.getByRole("button", { name: "Maximize logs" }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByRole("region", { name: "Log output" })).toHaveFocus()

    // The reported bug: Find… did nothing here.
    await find("open")
    const input = within(dialog).getByRole("textbox", { name: "Find in logs" })
    expect(input).toHaveFocus()
    expect(document.querySelector('[aria-label="Find in page"]')).toBeNull()
    await user.type(input, "nat_gateway")
    expect(within(dialog).getByRole("status")).toHaveTextContent("3 of 3")

    await user.keyboard("{Escape}")
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(within(dialog).queryByRole("search")).not.toBeInTheDocument()
    expect(within(dialog).getByRole("region", { name: "Log output" })).toHaveFocus()

    await user.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("keeps the search across maximizing and minimizing", async () => {
    const user = userEvent.setup()
    renderLogs()
    await user.click(screen.getByRole("button", { name: "Search logs" }))
    await user.type(logInput(), "creat")
    await user.keyboard("{Enter}")
    expect(logStatus()).toHaveTextContent("1 of 4")

    await user.click(screen.getByRole("button", { name: "Maximize logs" }))
    const dialog = screen.getByRole("dialog")
    const input = within(dialog).getByRole("textbox", { name: "Find in logs" })
    expect(input).toHaveValue("creat")
    expect(input).toHaveFocus()
    expect(within(dialog).getByRole("status")).toHaveTextContent("1 of 4")
    await user.keyboard("{Enter}")

    await user.click(within(dialog).getByRole("button", { name: "Minimize logs" }))
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(logStatus()).toHaveTextContent("2 of 4")
  })
})

describe("ViewLogs jump buttons", () => {
  /** Give the log body a scrollable size, which jsdom doesn't lay out. */
  function sizeBody(scrollHeight: number, clientHeight: number) {
    const body = logBody()
    Object.defineProperty(body, "scrollHeight", { configurable: true, value: scrollHeight })
    Object.defineProperty(body, "clientHeight", { configurable: true, value: clientHeight })
    Object.defineProperty(body, "scrollTop", { configurable: true, writable: true, value: 0 })
    return body
  }

  function scrollTo(body: HTMLElement, top: number) {
    body.scrollTop = top
    fireEvent.scroll(body)
  }

  it("shows Jump to bottom above the end and Jump to top a screen down", async () => {
    const user = userEvent.setup()
    renderLogs()
    const body = sizeBody(1000, 100)
    expect(screen.queryByRole("button", { name: "Jump to bottom" })).not.toBeInTheDocument()

    scrollTo(body, 50)
    expect(screen.getByRole("button", { name: "Jump to bottom" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Jump to top" })).not.toBeInTheDocument()

    scrollTo(body, 500)
    expect(screen.getByRole("button", { name: "Jump to top" })).toBeInTheDocument()

    // Far from the end, the jump is instant rather than smooth.
    await user.click(screen.getByRole("button", { name: "Jump to top" }))
    expect(body.scrollTop).toBe(0)
    expect(body).toHaveFocus()

    await user.keyboard("{End}")
    expect(body.scrollTop).toBe(900)
    fireEvent.scroll(body)
    expect(screen.queryByRole("button", { name: "Jump to bottom" })).not.toBeInTheDocument()
    await user.keyboard("{Home}")
    expect(body.scrollTop).toBe(0)
  })

  it("counts new lines while scrolled up during a run, and follows again from the count", async () => {
    const user = userEvent.setup()
    const { rerenderLogs } = renderLogs({ logs: APPLY.slice(0, 2), status: "running" })
    const body = sizeBody(1000, 100)
    scrollTo(body, 300)
    expect(screen.getByRole("button", { name: "Jump to bottom" })).toBeInTheDocument()

    rerenderLogs({ logs: APPLY, status: "running" })
    const pill = screen.getByRole("button", { name: "Jump to bottom: 2 new lines" })
    expect(pill).toHaveTextContent("2 new lines")
    // Following is paused: the new lines didn't move the view.
    expect(body.scrollTop).toBe(300)

    await user.click(pill)
    expect(body.scrollTop).toBe(900)
    fireEvent.scroll(body)
    expect(screen.queryByRole("button", { name: /^Jump to bottom/ })).not.toBeInTheDocument()

    // Following again: the next line scrolls the view to the end.
    Object.defineProperty(body, "scrollHeight", { configurable: true, value: 1100 })
    rerenderLogs({ logs: [...APPLY, entry("Still creating...")], status: "running" })
    expect(body.scrollTop).toBe(1100)
  })

  it("goes back to the plain button when the run ends", () => {
    const { rerenderLogs } = renderLogs({ logs: APPLY.slice(0, 2), status: "running" })
    const body = sizeBody(1000, 100)
    scrollTo(body, 300)
    rerenderLogs({ logs: APPLY, status: "running" })
    expect(screen.getByRole("button", { name: "Jump to bottom: 2 new lines" })).toBeInTheDocument()

    rerenderLogs({ logs: APPLY, status: "fail" })
    expect(screen.getByRole("button", { name: "Jump to bottom" })).toBeInTheDocument()
  })
})
