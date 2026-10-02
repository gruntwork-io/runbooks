import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { ThemeProvider } from "@/contexts/ThemeContext"
import { InstructionModeProvider } from "@/contexts/InstructionModeContext"
import { TelemetryContext, defaultContextValue } from "@/contexts/TelemetryContext.types"
import { ErrorReportingProvider } from "@/contexts/ErrorReportingContext"
import { GeneratedFilesProvider } from "@/contexts/GeneratedFilesContext"
import { IpcGitWorkTreeProvider } from "@/contexts/IpcGitWorkTreeContext"
import { LogsProvider } from "@/contexts/LogsContext"
import { useLogs } from "@/contexts/useLogs"
import { RunbookContextProvider } from "@/contexts/RunbookContext"
import App from "../App"

// The artifacts panel polls the workspace over IPC and the welcome screen
// checks the CLI install; neither is under test here. App renders the
// artifacts panel directly, so its render count tracks App's.
const artifactsRenders = vi.hoisted(() => ({ count: 0 }))
vi.mock("@/components/layout/ArtifactsContainer", () => ({
  ArtifactsContainer: () => {
    artifactsRenders.count++
    return null
  },
}))
vi.mock("@/components/layout/WelcomeScreen", () => ({
  WelcomeScreen: () => <div>Welcome</div>,
}))
// The real provider, wrapped so a test can see the props App passes down to it.
vi.mock("@/contexts/RunbookContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/contexts/RunbookContext")>()
  return { ...actual, RunbookContextProvider: vi.fn(actual.RunbookContextProvider) }
})

interface RunbookFixture {
  path: string
  content: string
}

const RUNBOOKS: Record<string, RunbookFixture> = {
  "/work/a": { path: "/work/a/runbook.mdx", content: "# Runbook A\n" },
  "/work/b": { path: "/work/b/runbook.mdx", content: "# Runbook B\n" },
  "/work/c": { path: "/work/c/runbook.mdx", content: "# Runbook C\n" },
}

/** The names of a runbook's first session and of the one a reset replaces it with. */
const SESSION_NAMES = ["elegant-elephant", "brave-otter"]

const NO_RUNBOOK_MESSAGE = (dir: string) =>
  `This folder doesn't contain a runbook.mdx file:\n\n${dir}\n\nChoose a folder that contains a runbook.mdx file, or select a runbook file directly.`

interface ApiOptions {
  /** Existing generated file count per runbook file path. */
  generatedFiles?: Record<string, number>
  /** Make `generated-files:delete` reject, as a permissions error would. */
  deleteFails?: boolean
  /** Report `isWatchMode` from `runbook:get`, as a `--watch` launch does. */
  watchMode?: boolean
}

/**
 * Mock preload api. `runbook:get` serves RUNBOOKS (and rejects like the real
 * handler for anything else); `generated-files:check` and
 * `generated-files:delete` act on whichever runbook was loaded last, like the
 * real session-scoped handlers, with the file count from `generatedFiles`.
 */
function makeApi({ generatedFiles = {}, deleteFails = false, watchMode = false }: ApiOptions = {}) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  let current: RunbookFixture | null = null
  // How many times each runbook was given a new session (see newSession).
  const sessionCounts = new Map<string, number>()

  const invoke = vi.fn(
    async (channel: string, params?: { path?: string; remoteSource?: string; reload?: string }) => {
      switch (channel) {
        case "native:get-cli-config":
          return {}
        case "runbook:get": {
          // A runbook's directory or its runbook.mdx, like resolveRunbookPath
          const fixture = params?.path
            ? (RUNBOOKS[params.path] ?? Object.values(RUNBOOKS).find((r) => r.path === params.path))
            : undefined
          if (!fixture) throw new Error(NO_RUNBOOK_MESSAGE(params?.path ?? ""))
          current = fixture
          return {
            path: fixture.path,
            content: fixture.content,
            contentHash: fixture.path,
            language: "mdx",
            size: fixture.content.length,
            isWatchMode: watchMode,
            warnings: [],
            remoteSource: params?.remoteSource,
            sessionId: `session-${sessionCounts.get(fixture.path) ?? 0}`,
            sessionName: SESSION_NAMES[sessionCounts.get(fixture.path) ?? 0],
          }
        }
        case "generated-files:check": {
          const fileCount = current ? (generatedFiles[current.path] ?? 0) : 0
          return {
            hasFiles: fileCount > 0,
            fileCount,
            absoluteOutputPath: `${current?.path ?? ""}/generated`,
            relativeOutputPath: "generated",
          }
        }
        case "generated-files:delete": {
          if (deleteFails) throw new Error("EACCES: permission denied")
          const deletedCount = current ? (generatedFiles[current.path] ?? 0) : 0
          return {
            ok: true,
            success: true,
            deletedCount,
            message: `Successfully deleted ${deletedCount} file(s) from ${current?.path ?? ""}/generated`,
          }
        }
        default:
          return undefined
      }
    },
  )

  const on = vi.fn((channel: string, cb: (payload: unknown) => void) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)!.add(cb)
    return () => listeners.get(channel)?.delete(cb)
  })

  const emit = async (channel: string, payload?: unknown) => {
    await act(async () => {
      listeners.get(channel)?.forEach((cb) => cb(payload))
    })
  }

  /**
   * What File > Reset Session does in main: the next `runbook:get` for the open
   * runbook answers with a new session, and main asks the renderer to load it.
   */
  const newSession = async () => {
    if (!current) throw new Error("no runbook is open")
    sessionCounts.set(current.path, (sessionCounts.get(current.path) ?? 0) + 1)
    await emit("file:open-runbook", { path: current.path })
  }

  const api = { invoke, on } as unknown as Parameters<typeof ApiProvider>[0]["api"]
  return { api, invoke, emit, newSession }
}

/** Stands in for a block of the open runbook writing to the shared logs store. */
function LogSeeder() {
  const { registerLogs } = useLogs()
  return (
    <button
      onClick={() =>
        registerLogs("create_account", [
          { line: "account_id=123", timestamp: "2026-01-01T00:00:00Z" },
        ])
      }
    >
      Seed logs
    </button>
  )
}

const originalApi = window.api

function renderApp(options?: ApiOptions) {
  const mock = makeApi(options)
  // useApiGeneratedFilesDelete still calls window.api directly; point it at
  // the same mock the ApiProvider serves.
  window.api = mock.api
  render(
    <ApiProvider api={mock.api}>
      <ThemeProvider>
        <InstructionModeProvider>
          <TelemetryContext.Provider value={defaultContextValue}>
            <ErrorReportingProvider>
              <GeneratedFilesProvider>
                <IpcGitWorkTreeProvider>
                  <LogsProvider>
                    <LogSeeder />
                    <App />
                  </LogsProvider>
                </IpcGitWorkTreeProvider>
              </GeneratedFilesProvider>
            </ErrorReportingProvider>
          </TelemetryContext.Provider>
        </InstructionModeProvider>
      </ThemeProvider>
    </ApiProvider>,
  )
  return mock
}

function callsTo(invoke: ReturnType<typeof makeApi>["invoke"], channel: string) {
  return invoke.mock.calls.filter(([c]) => c === channel)
}

function runbookGetCallsFor(invoke: ReturnType<typeof makeApi>["invoke"], path: string) {
  return callsTo(invoke, "runbook:get").filter(([, params]) => params?.path === path).length
}

async function openRunbook(emit: ReturnType<typeof makeApi>["emit"], dir: string, heading: string) {
  await emit("file:open-runbook", { path: dir })
  // hidden: a modal (e.g. the generated-files alert) aria-hides the page behind it.
  expect(await screen.findByRole("heading", { name: heading, hidden: true })).toBeInTheDocument()
}

const TRUST_BUTTON = { name: /I trust this Runbook/ }

/**
 * Confirm the "trust this runbook" banner. Its button disables at once; the
 * banner then fades out on real timers, which the tests don't wait for.
 */
async function trustRunbook() {
  const button = await screen.findByRole("button", TRUST_BUTTON)
  fireEvent.click(button)
  expect(button).toBeDisabled()
}

/** Whether the open runbook's trust banner still asks to be confirmed. */
function isTrustPending() {
  const button = screen.queryByRole("button", TRUST_BUTTON)
  return button !== null && !(button as HTMLButtonElement).disabled
}

/** Open the header menu (as Cmd+, does) and report whether log download is enabled. */
async function isLogDownloadEnabled(emit: ReturnType<typeof makeApi>["emit"]) {
  await emit("menu:preferences")
  const item = await screen.findByRole("menuitem", { name: /Download logs \(Raw\)/ })
  const enabled = !item.hasAttribute("data-disabled")
  fireEvent.keyDown(item, { key: "Escape" })
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument())
  return enabled
}

describe("App runbook switching", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    window.api = originalApi
  })

  it("resets per-runbook state when a different runbook is opened without closing the first", async () => {
    const { invoke, emit } = renderApp()
    await openRunbook(emit, "/work/a", "Runbook A")
    await trustRunbook()
    fireEvent.click(screen.getByRole("button", { name: "Seed logs" }))
    expect(await isLogDownloadEnabled(emit)).toBe(true)
    const checksBefore = callsTo(invoke, "generated-files:check").length

    await openRunbook(emit, "/work/b", "Runbook B")

    // B starts from a fresh RunbookContext, so its trust banner asks again.
    expect(isTrustPending()).toBe(true)
    // A's logs no longer count toward the download.
    expect(await isLogDownloadEnabled(emit)).toBe(false)
    // The generated-files check runs again for B's session.
    await waitFor(() =>
      expect(callsTo(invoke, "generated-files:check").length).toBeGreaterThan(checksBefore),
    )
    expect(callsTo(invoke, "generated-files:check").at(-1)?.[1]).toEqual({
      sessionKey: "/work/b/runbook.mdx\nsession-0",
    })
  })

  it("resets per-runbook state when the open runbook starts a new session", async () => {
    const { invoke, emit, newSession } = renderApp()
    await openRunbook(emit, "/work/a", "Runbook A")
    await trustRunbook()
    fireEvent.click(screen.getByRole("button", { name: "Seed logs" }))
    expect(await isLogDownloadEnabled(emit)).toBe(true)
    const checksBefore = callsTo(invoke, "generated-files:check").length

    await newSession()

    // The same runbook, but its blocks start over: the trust banner asks again.
    await waitFor(() => expect(isTrustPending()).toBe(true))
    expect(screen.getByRole("heading", { name: "Runbook A" })).toBeInTheDocument()
    expect(await isLogDownloadEnabled(emit)).toBe(false)
    // The new session has its own generated-files directory to check.
    await waitFor(() =>
      expect(callsTo(invoke, "generated-files:check").length).toBeGreaterThan(checksBefore),
    )
    expect(callsTo(invoke, "generated-files:check").at(-1)?.[1]).toEqual({
      sessionKey: "/work/a/runbook.mdx\nsession-1",
    })
  })

  it("shows the session's name in the header and the window title", async () => {
    const { emit, newSession } = renderApp()
    expect(screen.queryByTestId("session-name")).not.toBeInTheDocument()

    await openRunbook(emit, "/work/a", "Runbook A")
    expect(screen.getByTestId("session-name")).toHaveTextContent("elegant-elephant")
    expect(document.title).toBe("elegant-elephant - Gruntwork Runbooks")

    // A reset replaces the session, and the name with it.
    await newSession()
    await waitFor(() => expect(screen.getByTestId("session-name")).toHaveTextContent("brave-otter"))
    expect(document.title).toBe("brave-otter - Gruntwork Runbooks")

    await emit("menu:close-runbook")
    expect(await screen.findByText("Welcome")).toBeInTheDocument()
    expect(screen.queryByTestId("session-name")).not.toBeInTheDocument()
    expect(document.title).toBe("Gruntwork Runbooks")
  })

  it("clears the previous runbook logs when it is closed before the next one opens", async () => {
    const { emit } = renderApp()
    await openRunbook(emit, "/work/a", "Runbook A")
    fireEvent.click(screen.getByRole("button", { name: "Seed logs" }))
    expect(await isLogDownloadEnabled(emit)).toBe(true)

    await emit("menu:close-runbook")
    expect(await screen.findByText("Welcome")).toBeInTheDocument()
    await openRunbook(emit, "/work/b", "Runbook B")

    // The logs store lives above App, so closing alone doesn't empty it; the
    // reset also has to run when the path goes to undefined and back.
    expect(await isLogDownloadEnabled(emit)).toBe(false)
  })

  it("does not re-render the app when a block writes logs", async () => {
    const { emit } = renderApp()
    await openRunbook(emit, "/work/a", "Runbook A")
    // Let App's own delayed state (the "show code" button timer) settle first.
    await screen.findByTitle("Show generated files", {}, { timeout: 3000 })

    const rendersBefore = artifactsRenders.count
    fireEvent.click(screen.getByRole("button", { name: "Seed logs" }))

    // Streamed log lines update the logs store; only its readers (the header,
    // the blocks) re-render, not App and the whole runbook under it.
    expect(artifactsRenders.count).toBe(rendersBefore)
    expect(await isLogDownloadEnabled(emit)).toBe(true)
  })

  it("keeps per-runbook state when the same runbook is opened again", async () => {
    const { invoke, emit } = renderApp()
    await openRunbook(emit, "/work/a", "Runbook A")
    await trustRunbook()
    fireEvent.click(screen.getByRole("button", { name: "Seed logs" }))
    const checksBefore = callsTo(invoke, "generated-files:check").length

    await emit("file:open-runbook", { path: "/work/a" })

    // The repeat open re-reads the runbook...
    await waitFor(() => expect(runbookGetCallsFor(invoke, "/work/a")).toBe(2))
    expect(screen.getByRole("heading", { name: "Runbook A" })).toBeInTheDocument()
    // ...but it is the same runbook, so its state survives.
    expect(isTrustPending()).toBe(false)
    expect(await isLogDownloadEnabled(emit)).toBe(true)
    expect(callsTo(invoke, "generated-files:check").length).toBe(checksBefore)
  })

  it("checks generated files for each runbook, even after the alert was dismissed in the previous one", async () => {
    const { emit } = renderApp({
      generatedFiles: { "/work/a/runbook.mdx": 3, "/work/b/runbook.mdx": 1 },
    })

    await openRunbook(emit, "/work/a", "Runbook A")
    expect(await screen.findByText("Existing Generated Files Detected")).toBeInTheDocument()
    expect(screen.getByText(/There are 3 files/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Keep Files" }))
    await waitFor(() =>
      expect(screen.queryByText("Existing Generated Files Detected")).not.toBeInTheDocument(),
    )

    await openRunbook(emit, "/work/b", "Runbook B")
    expect(await screen.findByText(/There is 1 file/)).toBeInTheDocument()

    // Switching while the alert is open closes it when the new runbook has none.
    await openRunbook(emit, "/work/c", "Runbook C")
    await waitFor(() =>
      expect(screen.queryByText("Existing Generated Files Detected")).not.toBeInTheDocument(),
    )
  })

  it.each([
    { outcome: "succeeded", deleteFails: false, resultTitle: "Files Deleted Successfully" },
    { outcome: "failed", deleteFails: true, resultTitle: "Failed to Delete Files" },
  ])(
    "prompts for the next runbook after a delete that $outcome in the previous one",
    async ({ deleteFails, resultTitle }) => {
      const { invoke, emit } = renderApp({
        generatedFiles: { "/work/a/runbook.mdx": 3, "/work/b/runbook.mdx": 1 },
        deleteFails,
      })

      await openRunbook(emit, "/work/a", "Runbook A")
      expect(await screen.findByText(/There are 3 files/)).toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "Delete Files" }))
      await waitFor(() => expect(callsTo(invoke, "generated-files:delete")).toHaveLength(1))
      if (deleteFails) {
        // A failed delete keeps the dialog open on its error until closed.
        expect(await screen.findByText(resultTitle)).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Close" }))
      }
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())

      await openRunbook(emit, "/work/b", "Runbook B")

      // B gets its own Keep/Delete prompt, not A's delete result.
      expect(await screen.findByText("Existing Generated Files Detected")).toBeInTheDocument()
      expect(screen.getByText(/There is 1 file/)).toBeInTheDocument()
      expect(screen.queryByText(resultTitle)).not.toBeInTheDocument()
    },
  )
})

describe("App runbook context", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    window.api = originalApi
  })

  it("passes the open runbook's file path down to its blocks", async () => {
    // Blocks read it from the runbook context, e.g. to name the runbook in
    // the logs' "Copy prompt for LLM".
    const { emit } = renderApp()
    await openRunbook(emit, "/work/a", "Runbook A")

    const props = vi.mocked(RunbookContextProvider).mock.lastCall?.[0]
    expect(props?.runbookFilePath).toBe("/work/a/runbook.mdx")
  })
})

describe("App failed runbook opens", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    window.api = originalApi
  })

  it("reports a failed open over the runbook that is still showing", async () => {
    const { emit } = renderApp()
    await openRunbook(emit, "/work/a", "Runbook A")

    await emit("file:open-runbook", { path: "/work/empty" })

    expect(
      await screen.findByText(/This folder doesn't contain a runbook\.mdx file/),
    ).toBeInTheDocument()
    expect(screen.getByText("Couldn't open runbook")).toBeInTheDocument()
    expect(screen.getByText("/work/a/runbook.mdx", { selector: "span" })).toBeInTheDocument()
    // A stays mounted.
    expect(screen.getByRole("heading", { name: "Runbook A" })).toBeInTheDocument()
  })

  it("retries the failed path from the banner", async () => {
    const { invoke, emit } = renderApp()
    await openRunbook(emit, "/work/a", "Runbook A")
    await emit("file:open-runbook", { path: "/work/empty" })
    await screen.findByText(/This folder doesn't contain a runbook\.mdx file/)
    expect(runbookGetCallsFor(invoke, "/work/empty")).toBe(1)

    fireEvent.click(screen.getByRole("button", { name: "Retry" }))

    await waitFor(() => expect(runbookGetCallsFor(invoke, "/work/empty")).toBe(2))
    expect(
      await screen.findByText(/This folder doesn't contain a runbook\.mdx file/),
    ).toBeInTheDocument()
  })

  it("tries again when the same failed path is opened a second time", async () => {
    const { invoke, emit } = renderApp()
    await openRunbook(emit, "/work/a", "Runbook A")
    await emit("file:open-runbook", { path: "/work/empty" })
    await screen.findByText(/This folder doesn't contain a runbook\.mdx file/)

    await emit("file:open-runbook", { path: "/work/empty" })

    await waitFor(() => expect(runbookGetCallsFor(invoke, "/work/empty")).toBe(2))
  })

  it("hides the banner on dismiss and keeps the current runbook", async () => {
    const { emit } = renderApp()
    await openRunbook(emit, "/work/a", "Runbook A")
    await emit("file:open-runbook", { path: "/work/empty" })
    await screen.findByText(/This folder doesn't contain a runbook\.mdx file/)

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))

    expect(
      screen.queryByText(/This folder doesn't contain a runbook\.mdx file/),
    ).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Runbook A" })).toBeInTheDocument()
  })

  it("shows the full-screen error when the first open fails", async () => {
    const { invoke, emit } = renderApp()

    await emit("file:open-runbook", { path: "/work/empty" })

    expect(
      await screen.findByText(/This folder doesn't contain a runbook\.mdx file/),
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Choose Another Folder" }))
    expect(callsTo(invoke, "native:open-runbook-dialog")).toHaveLength(1)
  })
})

describe("App watch mode", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    window.api = originalApi
  })

  /** The main process's watcher reporting a change to the runbook it watches. */
  const fileChanged = (emit: ReturnType<typeof makeApi>["emit"], path: string) =>
    emit("watch:file-change", { type: "reload", path })

  it("reloads the open runbook when its file changes", async () => {
    const { invoke, emit } = renderApp({ watchMode: true })
    await openRunbook(emit, "/work/a", "Runbook A")
    const callsBefore = callsTo(invoke, "runbook:get").length

    await fileChanged(emit, "/work/a/runbook.mdx")

    await waitFor(() => expect(callsTo(invoke, "runbook:get").length).toBe(callsBefore + 1))
    // Marked as a watch reload, so main keeps the session's working dir; the
    // open that loaded it wasn't.
    expect(callsTo(invoke, "runbook:get").at(-1)?.[1]).toMatchObject({
      path: "/work/a",
      reload: "watch",
    })
    expect(callsTo(invoke, "runbook:get").at(-2)?.[1]?.reload).toBeUndefined()

    // A later open of the same runbook is an open again, not a watch reload.
    await emit("file:open-runbook", { path: "/work/a" })
    await waitFor(() => expect(callsTo(invoke, "runbook:get").length).toBe(callsBefore + 2))
    expect(callsTo(invoke, "runbook:get").at(-1)?.[1]?.reload).toBeUndefined()
    await fileChanged(emit, "/work/a/runbook.mdx")
    await waitFor(() => expect(callsTo(invoke, "runbook:get").length).toBe(callsBefore + 3))
    expect(callsTo(invoke, "runbook:get").at(-1)?.[1]).toMatchObject({
      path: "/work/a",
      reload: "watch",
    })
  })

  it("reloads the displayed runbook, not a failed open, and keeps a dismissed error dismissed", async () => {
    const { invoke, emit } = renderApp({ watchMode: true })
    await openRunbook(emit, "/work/a", "Runbook A")
    // A failed open leaves A on screen; main keeps watching A.
    await emit("file:open-runbook", { path: "/work/empty" })
    await screen.findByText(/This folder doesn't contain a runbook\.mdx file/)
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))

    await fileChanged(emit, "/work/a/runbook.mdx")

    await waitFor(() => expect(runbookGetCallsFor(invoke, "/work/a/runbook.mdx")).toBe(1))
    // Every save used to re-send the failed open and raise its banner again.
    expect(runbookGetCallsFor(invoke, "/work/empty")).toBe(1)
    expect(
      screen.queryByText(/This folder doesn't contain a runbook\.mdx file/),
    ).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Runbook A" })).toBeInTheDocument()

    // The request is now the displayed runbook again, so later saves reload it.
    await fileChanged(emit, "/work/a/runbook.mdx")
    await waitFor(() => expect(runbookGetCallsFor(invoke, "/work/a/runbook.mdx")).toBe(2))
    expect(runbookGetCallsFor(invoke, "/work/empty")).toBe(1)
    // Both reloads are marked as watch reloads.
    const reloads = callsTo(invoke, "runbook:get").filter(
      ([, params]) => params?.path === "/work/a/runbook.mdx",
    )
    expect(reloads.map(([, params]) => params?.reload)).toEqual(["watch", "watch"])
  })
})
