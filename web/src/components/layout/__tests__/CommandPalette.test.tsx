import { useEffect } from "react"
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
  runbook?: React.ReactNode
  withLogs?: boolean
}

function renderPalette({ ctx: overrides, runbook, withLogs = false }: RenderOptions = {}) {
  const ctx = makeCtx(overrides)
  const invoke = vi.fn().mockResolvedValue({ ok: true })
  const api = { invoke, on: vi.fn(() => () => {}) } as unknown as Parameters<
    typeof ApiProvider
  >[0]["api"]
  const onOpenChange = vi.fn()
  render(
    <ApiProvider api={api}>
      <ThemeProvider>
        <InstructionModeProvider>
          <LogsProvider>
            {withLogs && <SomeLogs />}
            <Settings />
            <div className="markdown-body">{runbook}</div>
            <CommandPalette open onOpenChange={onOpenChange} ctx={ctx} />
          </LogsProvider>
        </InstructionModeProvider>
      </ThemeProvider>
    </ApiProvider>,
  )
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
    const { ctx, onOpenChange } = renderPalette()

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
    ])

    await select(/^Close Runbook/)
    expect(ctx.onCloseRunbook).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("leaves out what needs a runbook when none is open", () => {
    renderPalette({ ctx: { hasRunbookOpen: false } })
    expect(groupNames()).toEqual(["Runbook", "Appearance", "Command line", "Help"])
    expect(within(dialog()).queryByRole("option", { name: /Close Runbook/ })).toBeNull()
  })

  it("filters by label and by keyword", () => {
    renderPalette()
    fireEvent.change(input(), { target: { value: "artifacts" } })
    expect(optionNames()).toEqual(["Show generated files"])

    // "dark" finds the dark theme alone, not every theme through a shared keyword.
    fireEvent.change(input(), { target: { value: "dark" } })
    expect(optionNames()).toEqual(["Theme: Dark"])

    fireEvent.change(input(), { target: { value: "zzz" } })
    expect(within(dialog()).queryAllByRole("option")).toHaveLength(0)
    expect(dialog()).toHaveTextContent("No matching commands.")
  })

  it("names the generated files command after what it will do", async () => {
    const { ctx } = renderPalette({ ctx: { generatedFilesVisible: true } })
    await select("Hide generated files")
    expect(ctx.onToggleGeneratedFiles).toHaveBeenCalledOnce()
  })

  it("disables the logs downloads until a block has logged something", () => {
    renderPalette()
    expect(option("Download logs (Raw)")).toHaveAttribute("aria-disabled", "true")
  })

  it("enables the logs downloads once a block has logged", () => {
    renderPalette({ withLogs: true })
    expect(option("Download logs (Raw)")).toHaveAttribute("aria-disabled", "false")
  })

  it("marks the current theme and switches it", async () => {
    const { onOpenChange } = renderPalette()
    expect(option(/^Theme: System/)).toHaveTextContent("current")
    expect(option("Theme: Dark")).not.toHaveTextContent("current")

    await select("Theme: Dark")
    expect(screen.getByTestId("settings")).toHaveTextContent("dark interactive")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("turns instruction mode on, and names the command after the next state", async () => {
    renderPalette()
    await select("Turn on Instruction mode")
    expect(screen.getByTestId("settings")).toHaveTextContent("system instruction")
  })

  it("opens the docs and the issue tracker in the browser", async () => {
    const { invoke } = renderPalette()
    await select("Open documentation")
    await select("Report an issue")
    // ThemeProvider syncs the theme to the window chrome on mount; that call is not under test.
    expect(invoke.mock.calls.filter(([channel]) => channel === "native:open-external")).toEqual([
      ["native:open-external", { url: "https://docs.gruntwork.io/runbooks" }],
      ["native:open-external", { url: "https://github.com/gruntwork-io/runbooks/issues" }],
    ])
  })

  it("installs and uninstalls the CLI through main, which reports in its own dialog", async () => {
    const { invoke } = renderPalette()
    await select(/^Install 'runbooks'/)
    await select(/^Uninstall 'runbooks'/)
    expect(invoke.mock.calls.filter(([channel]) => channel.startsWith("cli:"))).toEqual([
      ["cli:install-with-dialog"],
      ["cli:uninstall-with-dialog"],
    ])
  })

  it("opens the find bar", async () => {
    const { ctx } = renderPalette()
    await select(/^Find in page/)
    expect(ctx.onFind).toHaveBeenCalledOnce()
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

    it("is absent from a runbook with no headings", () => {
      renderPalette()
      expect(within(dialog()).queryByRole("option", { name: /Jump to section/ })).toBeNull()
    })

    it("lists the runbook's headings, indented by level, without those inside blocks", async () => {
      renderPalette({ runbook })
      await select(/Jump to section/)
      expect(groupNames()).toEqual(["Sections"])
      expect(optionNames()).toEqual(["Deploy", "Prepare", "Verify", "Ship", "Verify (2)"])
      expect(option("Deploy")).toHaveStyle({ paddingLeft: "0.5rem" })
      expect(option("Prepare")).toHaveStyle({ paddingLeft: "1.5rem" })
      expect(option("Verify")).toHaveStyle({ paddingLeft: "2.5rem" })
      expect(input()).toHaveAttribute("placeholder", "Jump to section…")
    })

    it("scrolls to the chosen heading, even a repeated one, after revealing the runbook", async () => {
      vi.useFakeTimers({ toFake: ["requestAnimationFrame"] })
      try {
        const scroll = vi.spyOn(Element.prototype, "scrollIntoView")
        const { ctx, onOpenChange } = renderPalette({ runbook })
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

    it("goes back to the commands on Backspace in an empty search", async () => {
      renderPalette({ runbook })
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
