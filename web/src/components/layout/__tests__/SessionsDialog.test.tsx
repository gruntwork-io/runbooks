import { describe, it, expect, vi, beforeEach } from "vitest"
import { useState } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { SessionsDialog } from "../SessionsDialog"
import type { ListedSession } from "../../../../../src/domain/session/store"

// The IPC boundary is the only thing mocked: main lists, switches and deletes.
const invoke = vi.fn()
// One object, as the real ApiProvider gives every render.
const api = { invoke, on: () => () => {} }

vi.mock("@/contexts/ApiContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/contexts/ApiContext")>()
  return { ...actual, useApi: () => api }
})

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()

function session(overrides: Partial<ListedSession> & { id: string }): ListedSession {
  return {
    name: `name-${overrides.id}`,
    path: "/work/a/runbook.mdx",
    remoteSource: undefined,
    dir: `/sessions/dirs/${overrides.id}`,
    createdAt: hoursAgo(48),
    lastUsedAt: hoursAgo(1),
    executionCount: 0,
    isCurrent: false,
    runbookMissing: false,
    ...overrides,
  }
}

const SESSIONS = [
  session({ id: "b1", name: "brave-otter", path: "/work/b/runbook.mdx", executionCount: 1 }),
  session({ id: "a1", name: "elegant-elephant", isCurrent: true, executionCount: 3 }),
  session({ id: "a0", name: "calm-heron", lastUsedAt: hoursAgo(30) }),
  session({
    id: "r1",
    name: "quiet-lynx",
    path: "/tmp/clone/runbook.mdx",
    remoteSource: "https://github.com/acme/runbooks//deploy",
  }),
  session({ id: "g1", name: "lost-falcon", path: "/gone/runbook.mdx", runbookMissing: true }),
]

/** Main's answers, by channel. Each test overrides what it needs. */
let answers: Record<string, (params: unknown) => unknown>

beforeEach(() => {
  invoke.mockReset()
  answers = {
    "session:list": () => ({ sessions: SESSIONS }),
    "session:switch": () => ({ status: "switched" }),
    "session:delete": () => ({ ok: true }),
  }
  invoke.mockImplementation(async (channel: string, params: unknown) => answers[channel]!(params))
})

function renderDialog() {
  const onOpenChange = vi.fn()
  render(<SessionsDialog open onOpenChange={onOpenChange} />)
  return { onOpenChange }
}

/** The list item of the session named `name`. */
const row = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) }).closest("li")!
const callsTo = (channel: string) =>
  invoke.mock.calls.filter(([c]) => c === channel).map(([, params]) => params)

describe("SessionsDialog", () => {
  it("lists the sessions by runbook, the open runbook's first", async () => {
    renderDialog()

    await screen.findByText("elegant-elephant")
    const groups = screen.getAllByRole("region").map((region) => ({
      runbook: region.getAttribute("aria-label"),
      sessions: within(region)
        .getAllByRole("listitem")
        .map((item) => item.querySelector(".font-medium")?.textContent),
    }))
    expect(groups).toEqual([
      { runbook: "/work/a/runbook.mdx", sessions: ["elegant-elephant", "calm-heron"] },
      { runbook: "/work/b/runbook.mdx", sessions: ["brave-otter"] },
      { runbook: "https://github.com/acme/runbooks//deploy", sessions: ["quiet-lynx"] },
      { runbook: "/gone/runbook.mdx", sessions: ["lost-falcon"] },
    ])
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.queryByText("Loading sessions…")).not.toBeInTheDocument()
    expect(screen.queryByText("No saved sessions yet.")).not.toBeInTheDocument()
    expect(screen.queryByText(/No sessions match/)).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Delete calm-heron" })).toHaveAttribute(
      "title",
      "Delete calm-heron",
    )
  })

  it("says it is loading until main has listed the sessions", async () => {
    let finish!: (value: unknown) => void
    answers["session:list"] = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    renderDialog()

    expect(screen.getByText("Loading sessions…")).toBeInTheDocument()
    finish({ sessions: SESSIONS })
    await screen.findByText("elegant-elephant")
    expect(screen.queryByText("Loading sessions…")).not.toBeInTheDocument()
  })

  it("shows when each was used, how often it ran, which is open, and which can't be opened", async () => {
    renderDialog()

    expect(await screen.findByText("Used 1 hour ago, 3 runs")).toBeInTheDocument()
    expect(screen.getByText("Used yesterday, no runs")).toBeInTheDocument()
    expect(screen.getAllByText("Used 1 hour ago, 1 run")).toHaveLength(1)
    expect(within(row("elegant-elephant")).getByText("Open")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^elegant-elephant/ })).toBeDisabled()
    expect(screen.getByText("Its runbook is gone, so it can't be opened.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^lost-falcon/ })).toBeDisabled()
  })

  it("filters by session name or runbook", async () => {
    const user = userEvent.setup()
    renderDialog()
    await screen.findByText("elegant-elephant")
    const filter = screen.getByRole("searchbox", { name: "Filter sessions" })

    await user.type(filter, "HERON")
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("calm-heron"),
    ])

    await user.clear(filter)
    await user.type(filter, "acme")
    expect(screen.getByText("quiet-lynx")).toBeInTheDocument()
    expect(screen.queryByText("calm-heron")).not.toBeInTheDocument()

    await user.clear(filter)
    await user.type(filter, "  heron  ")
    expect(screen.getByText("calm-heron")).toBeInTheDocument()

    await user.clear(filter)
    await user.type(filter, " nothing ")
    expect(screen.getByText("No sessions match nothing.")).toBeInTheDocument()
  })

  it("says when there are no saved sessions", async () => {
    answers["session:list"] = () => ({ sessions: [] })
    renderDialog()

    expect(await screen.findByText("No saved sessions yet.")).toBeInTheDocument()
    expect(screen.queryByText(/No sessions match/)).not.toBeInTheDocument()
  })

  it("says why the sessions couldn't be listed", async () => {
    answers["session:list"] = () => {
      throw new Error("Error invoking remote method 'session:list': Error: database is locked")
    }
    renderDialog()

    expect(await screen.findByRole("alert")).toHaveTextContent("database is locked")
    expect(screen.queryByText("Loading sessions…")).not.toBeInTheDocument()
  })

  it("switches to a session and closes", async () => {
    const user = userEvent.setup()
    const { onOpenChange } = renderDialog()

    await user.click(await screen.findByRole("button", { name: /^brave-otter/ }))

    expect(callsTo("session:switch")).toEqual([{ id: "b1" }])
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("says it is cloning a remote session's runbook while it switches", async () => {
    const user = userEvent.setup()
    let finish!: (value: unknown) => void
    answers["session:switch"] = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    renderDialog()

    await user.click(await screen.findByRole("button", { name: /^quiet-lynx/ }))

    expect(within(row("quiet-lynx")).getByText("Cloning…")).toBeInTheDocument()
    expect(within(row("brave-otter")).queryByText(/Cloning|Opening/)).not.toBeInTheDocument()
    // Nothing else can be switched to or deleted meanwhile.
    expect(screen.getByRole("button", { name: /^brave-otter/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Delete brave-otter" })).toBeDisabled()
    finish({ status: "switched" })
  })

  it("says it is opening a local session's runbook while it switches", async () => {
    const user = userEvent.setup()
    answers["session:switch"] = () => new Promise(() => {})
    renderDialog()

    await user.click(await screen.findByRole("button", { name: /^brave-otter/ }))

    expect(within(row("brave-otter")).getByText("Opening…")).toBeInTheDocument()
  })

  it("says why main couldn't switch", async () => {
    const user = userEvent.setup()
    answers["session:switch"] = () => {
      throw new Error("Error invoking remote method 'session:switch': Error: no window")
    }
    renderDialog()

    await user.click(await screen.findByRole("button", { name: /^brave-otter/ }))

    expect(await screen.findByRole("alert")).toHaveTextContent("no window")
    expect(screen.getByRole("button", { name: /^brave-otter/ })).toBeEnabled()
  })

  it("ignores a switch's answer that comes after the dialog was closed", async () => {
    const user = userEvent.setup()
    let finish!: (value: unknown) => void
    answers["session:switch"] = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const { onOpenChange } = renderDialog()
    await user.click(await screen.findByRole("button", { name: /^brave-otter/ }))

    await user.keyboard("{Escape}")
    finish({ status: "script-running" })

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("asks before stopping a running script, and keeps the script running when told to", async () => {
    const user = userEvent.setup()
    answers["session:switch"] = (params) =>
      (params as { stopRunningScript?: boolean }).stopRunningScript
        ? { status: "switched" }
        : { status: "script-running" }
    const { onOpenChange } = renderDialog()

    await user.click(await screen.findByRole("button", { name: /^brave-otter/ }))
    const confirm = await screen.findByRole("alertdialog")
    expect(confirm).toHaveTextContent("Stop the running script?")
    expect(confirm).toHaveTextContent("Switching to brave-otter stops it.")

    await user.click(within(confirm).getByRole("button", { name: "Keep running" }))

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(callsTo("session:switch")).toEqual([{ id: "b1" }])
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("stops the running script and switches when the user agrees", async () => {
    const user = userEvent.setup()
    answers["session:switch"] = (params) =>
      (params as { stopRunningScript?: boolean }).stopRunningScript
        ? { status: "switched" }
        : { status: "script-running" }
    const { onOpenChange } = renderDialog()

    await user.click(await screen.findByRole("button", { name: /^brave-otter/ }))
    await user.click(await screen.findByRole("button", { name: "Stop and switch" }))

    expect(callsTo("session:switch")).toEqual([{ id: "b1" }, { id: "b1", stopRunningScript: true }])
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("says why a switch failed, and stays open", async () => {
    const user = userEvent.setup()
    answers["session:switch"] = () => ({ status: "failed", error: "repository not found" })
    const { onOpenChange } = renderDialog()

    await user.click(await screen.findByRole("button", { name: /^quiet-lynx/ }))

    expect(await screen.findByRole("alert")).toHaveTextContent("repository not found")
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: /^brave-otter/ })).toBeEnabled()
  })

  it("deletes a session once the user confirms it", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(await screen.findByRole("button", { name: "Delete calm-heron" }))
    expect(within(row("calm-heron")).getByText("Delete its files and history?")).toBeInTheDocument()
    expect(callsTo("session:delete")).toEqual([])
    await user.click(within(row("calm-heron")).getByRole("button", { name: "Delete" }))

    await waitFor(() => expect(screen.queryByText("calm-heron")).not.toBeInTheDocument())
    expect(callsTo("session:delete")).toEqual([{ id: "a0" }])
    expect(screen.getAllByRole("listitem")).toHaveLength(SESSIONS.length - 1)
  })

  it("says it is deleting, and blocks other changes, until main has deleted it", async () => {
    const user = userEvent.setup()
    answers["session:delete"] = () => new Promise(() => {})
    renderDialog()

    await user.click(await screen.findByRole("button", { name: "Delete calm-heron" }))
    await user.click(within(row("calm-heron")).getByRole("button", { name: "Delete" }))

    expect(within(row("calm-heron")).getByRole("button", { name: "Deleting…" })).toBeDisabled()
    expect(screen.getByRole("button", { name: /^brave-otter/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Delete brave-otter" })).toBeDisabled()
  })

  it("keeps a session whose delete was cancelled", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(await screen.findByRole("button", { name: "Delete calm-heron" }))
    await user.click(within(row("calm-heron")).getByRole("button", { name: "Cancel" }))

    expect(screen.getByRole("button", { name: "Delete calm-heron" })).toBeInTheDocument()
    expect(callsTo("session:delete")).toEqual([])
  })

  it("can't delete the open session", async () => {
    renderDialog()

    const remove = await screen.findByRole("button", { name: "Delete elegant-elephant" })
    expect(remove).toBeDisabled()
    expect(remove).toHaveAttribute("title", "Switch to another session to delete this one")
  })

  it("says why a delete failed, and keeps the session listed", async () => {
    const user = userEvent.setup()
    answers["session:delete"] = () => {
      throw new Error("Error invoking remote method 'session:delete': EACCES: permission denied")
    }
    renderDialog()

    await user.click(await screen.findByRole("button", { name: "Delete calm-heron" }))
    await user.click(within(row("calm-heron")).getByRole("button", { name: "Delete" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("EACCES: permission denied")
    expect(screen.getByRole("button", { name: "Delete calm-heron" })).toBeEnabled()
  })

  it("lists the sessions again each time it opens", async () => {
    const { rerender } = render(<SessionsDialog open onOpenChange={vi.fn()} />)
    await screen.findByText("elegant-elephant")

    rerender(<SessionsDialog open={false} onOpenChange={vi.fn()} />)
    answers["session:list"] = () => ({ sessions: [session({ id: "n", name: "new-one" })] })
    rerender(<SessionsDialog open onOpenChange={vi.fn()} />)

    expect(await screen.findByText("new-one")).toBeInTheDocument()
    expect(callsTo("session:list")).toHaveLength(2)
  })

  it("shows only the latest listing when an earlier one answers late", async () => {
    const user = userEvent.setup()
    const listings: Array<(value: unknown) => void> = []
    answers["session:list"] = () =>
      new Promise((resolve) => {
        listings.push(resolve)
      })
    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button onClick={() => setOpen(true)}>Sessions</button>
          <SessionsDialog open={open} onOpenChange={setOpen} />
        </>
      )
    }
    render(<Harness />)
    await waitFor(() => expect(listings).toHaveLength(1))

    await user.keyboard("{Escape}")
    await user.click(screen.getByRole("button", { name: "Sessions" }))
    await waitFor(() => expect(listings).toHaveLength(2))
    await act(async () => listings[0]!({ sessions: SESSIONS }))

    expect(screen.queryByText("elegant-elephant")).not.toBeInTheDocument()
    expect(screen.getByText("Loading sessions…")).toBeInTheDocument()
    await act(async () => listings[1]!({ sessions: [session({ id: "n", name: "new-one" })] }))
    expect(screen.getByText("new-one")).toBeInTheDocument()
  })

  it("does not carry a failure that answered after it closed into the next time it opens", async () => {
    const user = userEvent.setup()
    const failures: Array<(err: Error) => void> = []
    answers["session:switch"] = () =>
      new Promise((_resolve, reject) => {
        failures.push(reject)
      })
    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button onClick={() => setOpen(true)}>Sessions</button>
          <SessionsDialog open={open} onOpenChange={setOpen} />
        </>
      )
    }
    render(<Harness />)
    await user.click(await screen.findByRole("button", { name: /^brave-otter/ }))

    await user.keyboard("{Escape}")
    await act(async () => failures[0]!(new Error("too late")))
    await user.click(screen.getByRole("button", { name: "Sessions" }))

    await screen.findByText("elegant-elephant")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("keeps a session listed when its delete answers after the dialog was closed", async () => {
    const user = userEvent.setup()
    let finish!: (value: unknown) => void
    answers["session:delete"] = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const { onOpenChange } = renderDialog()
    await user.click(await screen.findByRole("button", { name: "Delete calm-heron" }))
    await user.click(within(row("calm-heron")).getByRole("button", { name: "Delete" }))

    await user.keyboard("{Escape}")
    await act(async () => finish({ ok: true }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
