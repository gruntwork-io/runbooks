import { useEffect, useState, type ReactNode } from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, within, act } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { ThemeProvider } from "@/contexts/ThemeContext"
import { InstructionModeProvider } from "@/contexts/InstructionModeContext"
import { LogsProvider } from "@/contexts/LogsContext"
import { useLogs } from "@/contexts/useLogs"
import { useTheme } from "@/contexts/useTheme"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { formatShortcut } from "@/lib/platform"
import { CommandPalette, type CommandPaletteContext } from "../CommandPalette"
import { FindBar, type FindBarHandle } from "../FindBar"

/** Registers one block's log line, so the logs commands are enabled. */
function SomeLogs() {
  const { registerLogs } = useLogs()
  useEffect(() => {
    registerLogs("block-1", [{ line: "hello", timestamp: "1970-01-01T00:00:00Z" }])
  }, [registerLogs])
  return null
}

/** Shows the theme and mode the palette's commands set. */
function Settings() {
  const { theme } = useTheme()
  const { enabled } = useInstructionMode()
  return (
    <output data-testid="settings">
      {theme} {enabled ? "instruction" : "interactive"}
    </output>
  )
}

function makeCtx(overrides: Partial<CommandPaletteContext> = {}): CommandPaletteContext {
  return {
    hasRunbookOpen: true,
    generatedFilesVisible: false,
    onOpenRunbook: vi.fn(),
    onOpenUrl: vi.fn(),
    onCloseRunbook: vi.fn(),
    onToggleGeneratedFiles: vi.fn(),
    onRevealRunbook: vi.fn(),
    onFind: vi.fn(),
    ...overrides,
  }
}

interface RenderOptions {
  ctx?: Partial<CommandPaletteContext>
  /** The runbook on the page behind the palette. */
  runbook?: ReactNode
  withLogs?: boolean
}

const APP_VERSION = "1.2.3"

/** A preload api that answers every channel with ok, and the version lookup with APP_VERSION. */
function makeApi() {
  const invoke = vi.fn((channel: string) =>
    Promise.resolve(channel === "native:app-version" ? { version: APP_VERSION } : { ok: true }),
  )
  const api = { invoke, on: vi.fn(() => () => {}) } as unknown as Parameters<
    typeof ApiProvider
  >[0]["api"]
  return { api, invoke }
}

function Providers({
  api,
  children,
}: {
  api: ReturnType<typeof makeApi>["api"]
  children: ReactNode
}) {
  return (
    <ApiProvider api={api}>
      <ThemeProvider>
        <InstructionModeProvider>
          <LogsProvider>{children}</LogsProvider>
        </InstructionModeProvider>
      </ThemeProvider>
    </ApiProvider>
  )
}

/** Render the palette open, and wait for the version row, the last to arrive. */
async function renderPalette({ ctx: overrides, runbook, withLogs = false }: RenderOptions = {}) {
  const ctx = makeCtx(overrides)
  const { api, invoke } = makeApi()
  const onOpenChange = vi.fn()
  render(
    <Providers api={api}>
      {withLogs && <SomeLogs />}
      <Settings />
      <div className="markdown-body">{runbook}</div>
      <CommandPalette open onOpenChange={onOpenChange} ctx={ctx} />
    </Providers>,
  )
  await within(dialog()).findByRole("option", { name: /^Runbooks v/ })
  return { ctx, invoke, onOpenChange }
}

const dialog = () => screen.getByRole("dialog")
const input = () => within(dialog()).getByRole("combobox")
const option = (name: string | RegExp) => within(dialog()).getByRole("option", { name })
const optionNames = () =>
  within(dialog())
    .getAllByRole("option")
    .map((o) => o.textContent)
const groupNames = () =>
  [...dialog().querySelectorAll("[cmdk-group-heading]")].map((g) => g.textContent)
/** Pick a command, and wait out the tick the palette runs it on. */
const select = async (name: string | RegExp) => {
  fireEvent.click(option(name))
  await act(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0)
      }),
  )
}

// Every heading is on screen: jsdom gives nothing a layout.
beforeEach(() => {
  localStorage.clear()
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([
    {} as DOMRect,
  ] as unknown as DOMRectList)
})

describe("CommandPalette", () => {
  it("lists the Header menu and application menu actions in groups, and closes after running one", async () => {
    const { ctx, onOpenChange } = await renderPalette()

    expect(groupNames()).toEqual([
      "Runbook",
      "Navigate",
      "Logs",
      "Appearance",
      "Command line",
      "Help",
    ])
    expect(optionNames()).toEqual([
      `Open Runbook…${formatShortcut("O")}`,
      `Open from URL…${formatShortcut("O", { shift: true })}`,
      `Close Runbook${formatShortcut("W", { shift: true })}`,
      `Find in page…${formatShortcut("F")}`,
      "Show generated files",
      "Download logs (Raw)",
      "Download logs (JSON)",
      "Theme: Light",
      "Theme: Dark",
      "Theme: Systemcurrent",
      "Turn on Instruction mode",
      "Install 'runbooks' command in PATH",
      "Uninstall 'runbooks' command from PATH",
      "Open documentation",
      "Report an issue",
      `Runbooks v${APP_VERSION}Copy`,
    ])

    await select(/^Close Runbook/)
    expect(ctx.onCloseRunbook).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("leaves out what needs a runbook when none is open", async () => {
    await renderPalette({ ctx: { hasRunbookOpen: false } })
    expect(groupNames()).toEqual(["Runbook", "Appearance", "Command line", "Help"])
    expect(within(dialog()).queryByRole("option", { name: /Close Runbook/ })).toBeNull()
  })

  it("filters by label and by keyword", async () => {
    await renderPalette()
    fireEvent.change(input(), { target: { value: "artifacts" } })
    expect(optionNames()).toEqual(["Show generated files", 'Find "artifacts" in page'])

    // "dark" finds the dark theme alone, not every theme through a shared keyword.
    fireEvent.change(input(), { target: { value: "dark" } })
    expect(optionNames()).toEqual(["Theme: Dark", 'Find "dark" in page'])

    // With a runbook open, a miss still offers to find the text in the page.
    fireEvent.change(input(), { target: { value: "zzz" } })
    expect(optionNames()).toEqual(['Find "zzz" in page'])
    expect(dialog()).not.toHaveTextContent("No matching commands.")
  })

  it("ends every search with a row that finds the typed text in the page", async () => {
    const { ctx, onOpenChange } = await renderPalette({ runbook: <h2>Prepare</h2> })
    expect(within(dialog()).queryByRole("option", { name: /^Find "/ })).toBeNull()

    fireEvent.change(input(), { target: { value: "pre" } })
    const names = optionNames()
    expect(names.at(-1)).toBe('Find "pre" in page')
    expect(names).toContain("Jump to section › Prepare")

    await select(/^Find "pre" in page/)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(ctx.onFind).toHaveBeenCalledWith("pre")
  })

  it("reports no matches without a runbook, where there is nothing to search", async () => {
    await renderPalette({ ctx: { hasRunbookOpen: false } })
    fireEvent.change(input(), { target: { value: "zzz" } })
    expect(within(dialog()).queryAllByRole("option")).toHaveLength(0)
    expect(dialog()).toHaveTextContent("No matching commands.")
  })

  it("names the generated files command after what it will do", async () => {
    const { ctx } = await renderPalette({ ctx: { generatedFilesVisible: true } })
    await select("Hide generated files")
    expect(ctx.onToggleGeneratedFiles).toHaveBeenCalledOnce()
  })

  it("disables the logs downloads until a block has logged something", async () => {
    await renderPalette()
    expect(option("Download logs (Raw)")).toHaveAttribute("aria-disabled", "true")
  })

  it("enables the logs downloads once a block has logged", async () => {
    await renderPalette({ withLogs: true })
    expect(option("Download logs (Raw)")).toHaveAttribute("aria-disabled", "false")
  })

  it("marks the current theme and switches it", async () => {
    const { onOpenChange } = await renderPalette()
    expect(option(/^Theme: System/)).toHaveTextContent("current")
    expect(option("Theme: Dark")).not.toHaveTextContent("current")

    await select("Theme: Dark")
    expect(screen.getByTestId("settings")).toHaveTextContent("dark interactive")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("turns instruction mode on, and names the command after the next state", async () => {
    await renderPalette()
    await select("Turn on Instruction mode")
    expect(screen.getByTestId("settings")).toHaveTextContent("system instruction")
  })

  it("opens the docs and the issue tracker in the browser", async () => {
    const { invoke } = await renderPalette()
    await select("Open documentation")
    await select("Report an issue")
    // ThemeProvider syncs the theme to the window chrome on mount; that call is not under test.
    expect(invoke.mock.calls.filter(([channel]) => channel === "native:open-external")).toEqual([
      ["native:open-external", { url: "https://docs.gruntwork.io/runbooks" }],
      ["native:open-external", { url: "https://github.com/gruntwork-io/runbooks/issues" }],
    ])
  })

  it("installs and uninstalls the CLI through main, which reports in its own dialog", async () => {
    const { invoke } = await renderPalette()
    await select(/^Install 'runbooks'/)
    await select(/^Uninstall 'runbooks'/)
    expect(invoke.mock.calls.filter(([channel]) => channel.startsWith("cli:"))).toEqual([
      ["cli:install-with-dialog"],
      ["cli:uninstall-with-dialog"],
    ])
  })

  it("shows the app's version, for a bug report, and copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    try {
      await renderPalette()
      fireEvent.change(input(), { target: { value: "version" } })
      expect(optionNames()[0]).toBe(`Runbooks v${APP_VERSION}Copy`)

      await select(/^Runbooks v/)
      expect(writeText).toHaveBeenCalledWith(APP_VERSION)
    } finally {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true })
    }
  })

  it("opens the find bar", async () => {
    const { ctx } = await renderPalette()
    await select(/^Find in page/)
    expect(ctx.onFind).toHaveBeenCalledOnce()
  })

  it("leaves an open find bar alone, with its matches", async () => {
    const { api } = makeApi()
    const findBar = { current: null as FindBarHandle | null }
    function Page() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Palette
          </button>
          <p>alpha one</p>
          <FindBar ref={findBar} />
          <CommandPalette open={open} onOpenChange={setOpen} ctx={makeCtx()} />
        </>
      )
    }
    render(
      <Providers api={api}>
        <Page />
      </Providers>,
    )
    // Role queries skip the page once the modal palette has aria-hidden it.
    const bar = () => document.querySelector('[role="search"]')
    const status = () => bar()?.querySelector('[role="status"]')?.textContent

    act(() => findBar.current?.open("alpha"))
    expect(status()).toBe("1 of 1")

    fireEvent.click(screen.getByRole("button", { name: "Palette" }))
    expect(dialog()).toBeInTheDocument()
    // The palette's own text, this row included, isn't a match.
    fireEvent.change(input(), { target: { value: "alpha" } })
    expect(option(/^Find "alpha" in page/)).toBeInTheDocument()
    // Wait out the find bar's rescan of the changed page.
    await act(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 250)
        }),
    )
    expect(bar()).not.toBeNull()
    expect(status()).toBe("1 of 1")

    fireEvent.keyDown(input(), { key: "Escape" })
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(status()).toBe("1 of 1")
  })

  describe("Jump to section", () => {
    const runbook = (
      <>
        <h1>Deploy</h1>
        <h2>Prepare</h2>
        <h3>Verify</h3>
        <div className="runbook-block">
          <h3>Form group heading</h3>
        </div>
        <h2>Ship</h2>
        <h3>Verify</h3>
      </>
    )

    it("is absent from a runbook with no headings", async () => {
      await renderPalette()
      expect(within(dialog()).queryByRole("option", { name: /Jump to section/ })).toBeNull()
    })

    it("lists the runbook's headings, indented by level, without those inside blocks", async () => {
      await renderPalette({ runbook })
      await select(/Jump to section/)
      expect(groupNames()).toEqual(["Sections"])
      expect(optionNames()).toEqual(["Deploy", "Prepare", "Verify", "Ship", "Verify (2)"])
      expect(option("Deploy")).toHaveStyle({ paddingLeft: "0.5rem" })
      expect(option("Prepare")).toHaveStyle({ paddingLeft: "1.5rem" })
      expect(option("Verify")).toHaveStyle({ paddingLeft: "2.5rem" })
      expect(input()).toHaveAttribute("placeholder", "Jump to section…")
    })

    it("leaves out a heading the runbook doesn't show, such as one in a collapsed block", async () => {
      vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
        return (this.closest(".collapsed") ? [] : [{}]) as unknown as DOMRectList
      })
      await renderPalette({
        runbook: (
          <>
            <h2>Shown</h2>
            <div className="collapsed">
              <h2>Folded away</h2>
            </div>
          </>
        ),
      })
      await select(/Jump to section/)
      expect(optionNames()).toEqual(["Shown"])
    })

    it("lists every heading while the narrow layout's Code tab hides the whole runbook", async () => {
      vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([] as unknown as DOMRectList)
      await renderPalette({ runbook })
      await select(/Jump to section/)
      expect(optionNames()).toEqual(["Deploy", "Prepare", "Verify", "Ship", "Verify (2)"])
    })

    it("scrolls to the chosen heading, even a repeated one, after revealing the runbook", async () => {
      vi.useFakeTimers({ toFake: ["requestAnimationFrame"] })
      try {
        const scroll = vi.spyOn(Element.prototype, "scrollIntoView")
        const { ctx, onOpenChange } = await renderPalette({ runbook })
        await select(/Jump to section/)
        await select("Verify (2)")

        expect(onOpenChange).toHaveBeenCalledWith(false)
        expect(ctx.onRevealRunbook).toHaveBeenCalledOnce()
        vi.runAllTimers()
        // cmdk scrolls its own selected item into view; only the heading scroll is under test.
        const scrolledHeadings = scroll.mock.contexts.filter(
          (el) => el instanceof HTMLHeadingElement,
        )
        // hidden: the page behind the still-open modal is aria-hidden.
        const verifyHeadings = screen.getAllByRole("heading", { name: "Verify", hidden: true })
        expect(scrolledHeadings).toEqual([verifyHeadings[1]])
      } finally {
        vi.useRealTimers()
      }
    })

    it("scrolls to a heading's replacement when a reload, as in watch mode, swapped it out", async () => {
      vi.useFakeTimers({ toFake: ["requestAnimationFrame"] })
      try {
        const scroll = vi.spyOn(Element.prototype, "scrollIntoView")
        await renderPalette({ runbook })
        await select(/Jump to section/)
        const replacement = document.createElement("h2")
        replacement.textContent = "Ship"
        screen.getByRole("heading", { name: "Ship", hidden: true }).replaceWith(replacement)

        await select("Ship")
        vi.runAllTimers()
        const scrolledHeadings = scroll.mock.contexts.filter(
          (el) => el instanceof HTMLHeadingElement,
        )
        expect(scrolledHeadings).toEqual([replacement])
      } finally {
        vi.useRealTimers()
      }
    })

    it("surfaces matching headings from the root list once the user types", async () => {
      vi.useFakeTimers({ toFake: ["requestAnimationFrame"] })
      try {
        const { ctx, onOpenChange } = await renderPalette({ runbook })
        // Nothing from the runbook until there is a query.
        expect(within(dialog()).queryByRole("option", { name: /Jump to section › / })).toBeNull()

        // Fuzzy matching lets "ship" reach a command too (s-h-i-p across
        // "Show generated files" and its "panel" keyword), but the heading,
        // a word-start match, ranks first.
        fireEvent.change(input(), { target: { value: "ship" } })
        expect(optionNames()[0]).toBe("Jump to section › Ship")
        expect(optionNames()).not.toContain("Jump to section › Deploy")

        // "section" lists every heading.
        fireEvent.change(input(), { target: { value: "section" } })
        expect(optionNames()).toEqual([
          "Jump to section…5 sections",
          "Jump to section › Deploy",
          "Jump to section › Prepare",
          "Jump to section › Verify",
          "Jump to section › Ship",
          "Jump to section › Verify (2)",
          'Find "section" in page',
        ])

        await select("Jump to section › Ship")
        expect(onOpenChange).toHaveBeenCalledWith(false)
        expect(ctx.onRevealRunbook).toHaveBeenCalledOnce()
      } finally {
        vi.useRealTimers()
      }
    })

    it("keeps a heading named like a command apart from that command", async () => {
      const { ctx } = await renderPalette({ runbook: <h2>Close Runbook</h2> })
      fireEvent.change(input(), { target: { value: "close runbook" } })
      expect(optionNames()).toEqual([
        `Close Runbook${formatShortcut("W", { shift: true })}`,
        "Jump to section › Close Runbook",
        'Find "close runbook" in page',
      ])

      await select("Jump to section › Close Runbook")
      expect(ctx.onRevealRunbook).toHaveBeenCalledOnce()
      expect(ctx.onCloseRunbook).not.toHaveBeenCalled()
    })

    it("goes back to the commands on Backspace in an empty search", async () => {
      await renderPalette({ runbook })
      await select(/Jump to section/)
      fireEvent.change(input(), { target: { value: "Sh" } })
      expect(optionNames()).toEqual(["Ship"])

      fireEvent.keyDown(input(), { key: "Backspace" })
      expect(groupNames()).toEqual(["Sections"])

      fireEvent.change(input(), { target: { value: "" } })
      fireEvent.keyDown(input(), { key: "Backspace" })
      expect(groupNames()).toEqual([
        "Runbook",
        "Navigate",
        "Logs",
        "Appearance",
        "Command line",
        "Help",
      ])
    })
  })
})
