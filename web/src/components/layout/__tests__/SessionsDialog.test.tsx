import { describe, it, expect, vi, beforeEach } from "vitest"
import { useState, type ReactNode } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApiProvider } from "@/contexts/ApiContext"
import { makeTestApi, type TestApi } from "@/test/test-api"
import { SessionsDialog } from "../SessionsDialog"
import type { ListedSession } from "../../../../../src/domain/session/store"

// The IPC boundary is the only thing faked: main lists, switches and deletes.
// One api per test, which the real ApiProvider gives every render. Each test
// overrides the answers it needs.
let testApi: TestApi
const withApi = {
  wrapper: ({ children }: { children: ReactNode }) => (
    <ApiProvider api={testApi.api}>{children}</ApiProvider>
  ),
}

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
    finishedAt: undefined,
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

beforeEach(() => {
  testApi = makeTestApi({
    "session:list": () => ({ sessions: SESSIONS }),
    "session:switch": () => ({ status: "switched" }),
    "session:delete": () => ({ ok: true }),
  })
})

function renderDialog() {
  const onOpenChange = vi.fn()
  render(<SessionsDialog open onOpenChange={onOpenChange} />, withApi)
  return { onOpenChange }
}

/** The list item of the session named `name`. */
const row = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) }).closest("li")!
/** The list item of the session named `name`, once the list has loaded. */
const rowAsync = async (name: string) =>
  (await screen.findByRole("button", { name: new RegExp(`^${name}`) })).closest("li")!
const callsTo: TestApi["callsTo"] = (channel) => testApi.callsTo(channel)

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
  })

  it("says what the delete icon does when hovered", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.hover(await screen.findByRole("button", { name: "Delete calm-heron" }))

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Delete session")
  })

  it("marks the sessions that are finished", async () => {
    testApi.handle("session:list", () => ({
      sessions: [
        session({ id: "f", name: "done-deal", finishedAt: hoursAgo(2) }),
        session({ id: "u", name: "still-going" }),
      ],
    }))
    renderDialog()

    expect(within(await rowAsync("done-deal")).getByText("Finished")).toBeInTheDocument()
    expect(within(row("still-going")).queryByText("Finished")).not.toBeInTheDocument()
  })

  it("says it is loading until main has listed the sessions", async () => {
    const listings = testApi.hold("session:list")
    renderDialog()

    expect(screen.getByText("Loading sessions…")).toBeInTheDocument()
    listings[0]!.resolve({ sessions: SESSIONS })
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
    testApi.handle("session:list", () => ({ sessions: [] }))
    renderDialog()

    expect(await screen.findByText("No saved sessions yet.")).toBeInTheDocument()
    expect(screen.queryByText(/No sessions match/)).not.toBeInTheDocument()
  })

  it("says why the sessions couldn't be listed", async () => {
    testApi.handle("session:list", () => {
      throw new Error("Error invoking remote method 'session:list': Error: database is locked")
    })
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
    const switches = testApi.hold("session:switch")
    renderDialog()

    await user.click(await screen.findByRole("button", { name: /^quiet-lynx/ }))

    expect(within(row("quiet-lynx")).getByText("Cloning…")).toBeInTheDocument()
    expect(within(row("brave-otter")).queryByText(/Cloning|Opening/)).not.toBeInTheDocument()
    // Nothing else can be switched to or deleted meanwhile.
    expect(screen.getByRole("button", { name: /^brave-otter/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Delete brave-otter" })).toBeDisabled()
    switches[0]!.resolve({ status: "switched" })
  })

  it("says it is opening a local session's runbook while it switches", async () => {
    const user = userEvent.setup()
    testApi.handle("session:switch", () => new Promise(() => {}))
    renderDialog()

    await user.click(await screen.findByRole("button", { name: /^brave-otter/ }))

    expect(within(row("brave-otter")).getByText("Opening…")).toBeInTheDocument()
  })

  it("says why main couldn't switch", async () => {
    const user = userEvent.setup()
    testApi.handle("session:switch", () => {
      throw new Error("Error invoking remote method 'session:switch': Error: no window")
    })
    renderDialog()

    await user.click(await screen.findByRole("button", { name: /^brave-otter/ }))

    expect(await screen.findByRole("alert")).toHaveTextContent("no window")
    expect(screen.getByRole("button", { name: /^brave-otter/ })).toBeEnabled()
  })

  it("ignores a switch's answer that comes after the dialog was closed", async () => {
    const user = userEvent.setup()
    const switches = testApi.hold("session:switch")
    const { onOpenChange } = renderDialog()
    await user.click(await screen.findByRole("button", { name: /^brave-otter/ }))

    await user.keyboard("{Escape}")
    switches[0]!.resolve({ status: "script-running" })

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("asks before stopping a running script, and keeps the script running when told to", async () => {
    const user = userEvent.setup()
    testApi.handle("session:switch", ({ stopRunningScript }) =>
      stopRunningScript ? { status: "switched" } : { status: "script-running" },
    )
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
    testApi.handle("session:switch", ({ stopRunningScript }) =>
      stopRunningScript ? { status: "switched" } : { status: "script-running" },
    )
    const { onOpenChange } = renderDialog()

    await user.click(await screen.findByRole("button", { name: /^brave-otter/ }))
    await user.click(await screen.findByRole("button", { name: "Stop and switch" }))

    expect(callsTo("session:switch")).toEqual([{ id: "b1" }, { id: "b1", stopRunningScript: true }])
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("says why a switch failed, and stays open", async () => {
    const user = userEvent.setup()
    testApi.handle("session:switch", () => ({ status: "failed", error: "repository not found" }))
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
    expect(
      within(row("calm-heron")).getByText("Delete it? Its files go to the trash."),
    ).toBeInTheDocument()
    expect(callsTo("session:delete")).toEqual([])
    await user.click(within(row("calm-heron")).getByRole("button", { name: "Delete" }))

    await waitFor(() => expect(screen.queryByText("calm-heron")).not.toBeInTheDocument())
    expect(callsTo("session:delete")).toEqual([{ id: "a0" }])
    expect(screen.getAllByRole("listitem")).toHaveLength(SESSIONS.length - 1)
  })

  it("says it is deleting, and blocks other changes, until main has deleted it", async () => {
    const user = userEvent.setup()
    testApi.handle("session:delete", () => new Promise(() => {}))
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

    const user = userEvent.setup()
    const remove = await screen.findByRole("button", { name: "Delete elegant-elephant" })
    expect(remove).toBeDisabled()

    // The disabled icon still says why, on hover.
    await user.hover(remove.parentElement!)
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Switch to another session to delete this one",
    )
  })

  it("says why a delete failed, and keeps the session listed", async () => {
    const user = userEvent.setup()
    testApi.handle("session:delete", () => {
      throw new Error("Error invoking remote method 'session:delete': EACCES: permission denied")
    })
    renderDialog()

    await user.click(await screen.findByRole("button", { name: "Delete calm-heron" }))
    await user.click(within(row("calm-heron")).getByRole("button", { name: "Delete" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("EACCES: permission denied")
    expect(screen.getByRole("button", { name: "Delete calm-heron" })).toBeEnabled()
  })

  it("lists the sessions again each time it opens", async () => {
    const { rerender } = render(<SessionsDialog open onOpenChange={vi.fn()} />, withApi)
    await screen.findByText("elegant-elephant")

    rerender(<SessionsDialog open={false} onOpenChange={vi.fn()} />)
    testApi.handle("session:list", () => ({ sessions: [session({ id: "n", name: "new-one" })] }))
    rerender(<SessionsDialog open onOpenChange={vi.fn()} />)

    expect(await screen.findByText("new-one")).toBeInTheDocument()
    expect(callsTo("session:list")).toHaveLength(2)
  })

  it("shows only the latest listing when an earlier one answers late", async () => {
    const user = userEvent.setup()
    const listings = testApi.hold("session:list")
    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button onClick={() => setOpen(true)}>Sessions</button>
          <SessionsDialog open={open} onOpenChange={setOpen} />
        </>
      )
    }
    render(<Harness />, withApi)
    await waitFor(() => expect(listings).toHaveLength(1))

    await user.keyboard("{Escape}")
    await user.click(screen.getByRole("button", { name: "Sessions" }))
    await waitFor(() => expect(listings).toHaveLength(2))
    await act(async () => listings[0]!.resolve({ sessions: SESSIONS }))

    expect(screen.queryByText("elegant-elephant")).not.toBeInTheDocument()
    expect(screen.getByText("Loading sessions…")).toBeInTheDocument()
    await act(async () =>
      listings[1]!.resolve({ sessions: [session({ id: "n", name: "new-one" })] }),
    )
    expect(screen.getByText("new-one")).toBeInTheDocument()
  })

  it("does not carry a failure that answered after it closed into the next time it opens", async () => {
    const user = userEvent.setup()
    const switches = testApi.hold("session:switch")
    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button onClick={() => setOpen(true)}>Sessions</button>
          <SessionsDialog open={open} onOpenChange={setOpen} />
        </>
      )
    }
    render(<Harness />, withApi)
    await user.click(await screen.findByRole("button", { name: /^brave-otter/ }))

    await user.keyboard("{Escape}")
    await act(async () => switches[0]!.reject(new Error("too late")))
    await user.click(screen.getByRole("button", { name: "Sessions" }))

    await screen.findByText("elegant-elephant")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("keeps a session listed when its delete answers after the dialog was closed", async () => {
    const user = userEvent.setup()
    const deletes = testApi.hold("session:delete")
    const { onOpenChange } = renderDialog()
    await user.click(await screen.findByRole("button", { name: "Delete calm-heron" }))
    await user.click(within(row("calm-heron")).getByRole("button", { name: "Delete" }))

    await user.keyboard("{Escape}")
    await act(async () => deletes[0]!.resolve({ ok: true }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
