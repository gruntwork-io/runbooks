import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { ThemeProvider } from "@/contexts/ThemeContext"
import { InstructionModeProvider } from "@/contexts/InstructionModeContext"
import { ErrorReportingProvider } from "@/contexts/ErrorReportingContext"
import { GeneratedFilesProvider } from "@/contexts/GeneratedFilesContext"
import { IpcGitWorkTreeProvider } from "@/contexts/IpcGitWorkTreeContext"
import { LogsProvider } from "@/contexts/LogsContext"
import { RunbookChaptersProvider } from "@/contexts/RunbookChaptersContext"
import App from "../App"

// What App does when main reports that the open runbook changed on disk.
// The mock boundary is the preload API. The artifacts panel and the welcome
// screen are not under test.
vi.mock("@/components/layout/ArtifactsContainer", () => ({
  ArtifactsContainer: () => null,
}))
vi.mock("@/components/layout/WelcomeScreen", () => ({
  WelcomeScreen: () => <div>Welcome</div>,
}))

const A = "/work/a/runbook.mdx"
const B = "/work/b/runbook.mdx"
const NOTICE_TITLE = "Runbook changed"
const RELOAD = { name: "Reload runbook" }

/** The hash main reports for `content`; any value that differs per content will do. */
const hashOf = (content: string) => `hash:${content}`

interface ApiOptions {
  /** Report `isWatchMode` from `runbook:get`, as a `--watch` launch does. */
  watchMode?: boolean
  /** Report `disableLiveFileReload` from `runbook:get`. */
  disableLiveFileReload?: boolean
  /** Report that the runbook opened in a new session in place of this finished one. */
  finishedSession?: { name: string; finishedAt: string }
  /** Report that opening the runbook resumed a saved session last used then. */
  resumedFrom?: string
  /** What runbook A holds on disk at the start. */
  content?: string
}

/**
 * Mock preload api. `runbook:get` reads the runbook from `disk`, which a
 * test edits, and rejects for a path with no runbook, like the real handler.
 * Every load of a runbook is in the same session.
 */
function makeApi({
  watchMode = false,
  disableLiveFileReload = false,
  finishedSession,
  resumedFrom,
  content: initialContent = "# Before edit\n",
}: ApiOptions = {}) {
  const disk = new Map<string, string>([
    [A, initialContent],
    [B, "# Runbook B\n"],
  ])
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const invoke = vi.fn(async (channel: string, params?: { path?: string }) => {
    switch (channel) {
      case "native:get-cli-config":
        return {}
      case "session:list":
        return { sessions: [] }
      case "runbook:get": {
        const runbookPath = params?.path ?? ""
        const content = disk.get(runbookPath)
        if (content === undefined) throw new Error(`This path no longer exists:\n\n${runbookPath}`)
        return {
          path: runbookPath,
          content,
          contentHash: hashOf(content),
          language: "mdx",
          size: content.length,
          isWatchMode: watchMode,
          disableLiveFileReload,
          warnings: [],
          sessionId: `session-${runbookPath}`,
          sessionName: "elegant-elephant",
          sessionDir: "/sessions/dirs/session-0",
          // A resumed session has the blocks' history to resume.
          blockStates: resumedFrom
            ? [{ blockId: "region", kind: "inputs", payload: { values: {}, submitted: false } }]
            : [],
          ...(finishedSession ? { finishedSession } : {}),
          ...(resumedFrom ? { sessionResumedFrom: resumedFrom } : {}),
        }
      }
      case "generated-files:check":
        return {
          hasFiles: false,
          fileCount: 0,
          absoluteOutputPath: "/sessions/dirs/session-0/generated",
          relativeOutputPath: "generated",
        }
      default:
        return undefined
    }
  })
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
  /** Write `content` to the runbook at `path`, and report it as main's watcher does. */
  const save = async (path: string, content: string) => {
    disk.set(path, content)
    await emit("watch:file-change", { type: "reload", path, contentHash: hashOf(content) })
  }
  const api = { invoke, on } as unknown as Parameters<typeof ApiProvider>[0]["api"]
  return { api, invoke, emit, save }
}

const originalApi = window.api

function renderApp(options?: ApiOptions) {
  const mock = makeApi(options)
  window.api = mock.api
  render(
    <ApiProvider api={mock.api}>
      <ThemeProvider>
        <InstructionModeProvider>
          <ErrorReportingProvider>
            <GeneratedFilesProvider>
              <IpcGitWorkTreeProvider>
                <LogsProvider>
                  <RunbookChaptersProvider>
                    <App />
                  </RunbookChaptersProvider>
                </LogsProvider>
              </IpcGitWorkTreeProvider>
            </GeneratedFilesProvider>
          </ErrorReportingProvider>
        </InstructionModeProvider>
      </ThemeProvider>
    </ApiProvider>,
  )
  return mock
}

const runbookGets = (invoke: ReturnType<typeof makeApi>["invoke"]) =>
  invoke.mock.calls.filter(([channel]) => channel === "runbook:get")

async function openA(emit: ReturnType<typeof makeApi>["emit"]) {
  await emit("file:open-runbook", { path: A })
  expect(await screen.findByRole("heading", { name: "Before edit" })).toBeInTheDocument()
}

describe("App: the open runbook changed on disk", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    window.api = originalApi
  })

  describe("without --watch", () => {
    it("offers a reload and keeps the loaded version until it is clicked", async () => {
      const { invoke, emit, save } = renderApp()
      await openA(emit)
      const loads = runbookGets(invoke).length

      await save(A, "# After edit\n")

      expect(await screen.findByText(NOTICE_TITLE)).toBeInTheDocument()
      expect(screen.getByText(/Reload to show and run the new version/)).toBeVisible()
      expect(screen.getByRole("heading", { name: "Before edit" })).toBeInTheDocument()
      expect(runbookGets(invoke)).toHaveLength(loads)

      fireEvent.click(screen.getByRole("button", RELOAD))

      expect(await screen.findByRole("heading", { name: "After edit" })).toBeInTheDocument()
      // A reload, which keeps the session, as a watch-mode reload does.
      expect(runbookGets(invoke)).toHaveLength(loads + 1)
      expect(runbookGets(invoke).at(-1)?.[1]).toMatchObject({ path: A, reload: true })
      expect(screen.queryByText(NOTICE_TITLE)).not.toBeInTheDocument()
    })

    it("shows nothing for a save that leaves the runbook as loaded, and goes when a save undoes the change", async () => {
      const { invoke, emit, save } = renderApp()
      await openA(emit)
      const loads = runbookGets(invoke).length

      await save(A, "# Before edit\n")
      expect(screen.queryByText(NOTICE_TITLE)).not.toBeInTheDocument()

      await save(A, "# After edit\n")
      expect(await screen.findByText(NOTICE_TITLE)).toBeInTheDocument()

      await save(A, "# Before edit\n")
      expect(screen.queryByText(NOTICE_TITLE)).not.toBeInTheDocument()
      expect(runbookGets(invoke)).toHaveLength(loads)
    })

    it("ignores a change to a runbook that is not the one on screen", async () => {
      const { emit, save } = renderApp()
      await openA(emit)

      await save(B, "# Runbook B, edited\n")

      expect(screen.queryByText(NOTICE_TITLE)).not.toBeInTheDocument()
    })

    it("drops the notice when another runbook is opened", async () => {
      const { emit, save } = renderApp()
      await openA(emit)
      await save(A, "# After edit\n")
      expect(await screen.findByText(NOTICE_TITLE)).toBeInTheDocument()

      await emit("file:open-runbook", { path: B })
      expect(await screen.findByRole("heading", { name: "Runbook B" })).toBeInTheDocument()

      expect(screen.queryByText(NOTICE_TITLE)).not.toBeInTheDocument()
    })

    it("reloads the runbook on screen, not an open that failed after it", async () => {
      const { invoke, emit, save } = renderApp()
      await openA(emit)
      await emit("file:open-runbook", { path: "/work/gone" })
      await screen.findByText(/This path no longer exists/)

      await save(A, "# After edit\n")
      fireEvent.click(await screen.findByRole("button", RELOAD))

      expect(await screen.findByRole("heading", { name: "After edit" })).toBeInTheDocument()
      expect(runbookGets(invoke).at(-1)?.[1]).toMatchObject({ path: A, reload: true })
    })

    it("shows the notice at the top of the runbook, where it scrolls away with it", async () => {
      const { emit, save } = renderApp()
      await openA(emit)

      await save(A, "# After edit\n")

      const changed = await screen.findByText(NOTICE_TITLE)
      expect(changed.closest('[data-testid="runbook-content"]')).not.toBeNull()
      const heading = screen.getByRole("heading", { name: "Before edit" })
      expect(changed.compareDocumentPosition(heading)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    })

    it.each([
      {
        notice: "New session elegant-elephant",
        options: {
          finishedSession: { name: "brave-badger", finishedAt: new Date().toISOString() },
        },
      },
      {
        notice: "Resumed session elegant-elephant",
        options: { resumedFrom: new Date(Date.now() - 60 * 60_000).toISOString() },
      },
    ])("shows the notice together with the $notice notice", async ({ notice, options }) => {
      const { emit, save } = renderApp(options)
      await openA(emit)
      const sessionNotice = await screen.findByText(notice)

      await save(A, "# After edit\n")

      const changed = await screen.findByText(NOTICE_TITLE)
      expect(sessionNotice).toBeInTheDocument()
      // The changed notice first, above the session notice.
      expect(changed.compareDocumentPosition(sessionNotice)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    })

    it("offers a reload of a runbook that fails to compile once a save fixes it", async () => {
      const { emit, save } = renderApp({ content: "# Broken\n\n<Admonition\n" })
      await emit("file:open-runbook", { path: A })
      const error = await screen.findByTestId("mdx-error")

      await save(A, "# Fixed\n")

      const changed = await screen.findByText(NOTICE_TITLE)
      expect(changed.compareDocumentPosition(error)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      fireEvent.click(screen.getByRole("button", RELOAD))

      expect(await screen.findByRole("heading", { name: "Fixed" })).toBeInTheDocument()
      expect(screen.queryByTestId("mdx-error")).not.toBeInTheDocument()
      expect(screen.queryByText(NOTICE_TITLE)).not.toBeInTheDocument()
    })

    it("stays dismissed for the change dismissed, and shows again for a later change", async () => {
      const { emit, save } = renderApp()
      await openA(emit)
      await save(A, "# After edit\n")
      const notice = (await screen.findByText(NOTICE_TITLE)).closest('[role="status"]')!

      fireEvent.click(within(notice as HTMLElement).getByRole("button", { name: "Dismiss" }))
      expect(screen.queryByText(NOTICE_TITLE)).not.toBeInTheDocument()

      // The same content again: still dismissed.
      await save(A, "# After edit\n")
      expect(screen.queryByText(NOTICE_TITLE)).not.toBeInTheDocument()

      await save(A, "# After another edit\n")
      expect(await screen.findByText(NOTICE_TITLE)).toBeInTheDocument()
      expect(screen.getByRole("heading", { name: "Before edit" })).toBeInTheDocument()
    })

    it("forgets a dismissal once a save changes the file to another version", async () => {
      const { emit, save } = renderApp()
      await openA(emit)
      await save(A, "# After edit\n")
      fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }))
      expect(screen.queryByText(NOTICE_TITLE)).not.toBeInTheDocument()

      // Back to the version loaded, then the dismissed version again.
      await save(A, "# Before edit\n")
      expect(screen.queryByText(NOTICE_TITLE)).not.toBeInTheDocument()
      await save(A, "# After edit\n")

      expect(await screen.findByText(NOTICE_TITLE)).toBeInTheDocument()
    })

    it("forgets a dismissal once the runbook is reloaded", async () => {
      const { emit, save } = renderApp()
      await openA(emit)
      await save(A, "# After edit\n")
      fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }))

      await save(A, "# Second edit\n")
      fireEvent.click(await screen.findByRole("button", RELOAD))
      expect(await screen.findByRole("heading", { name: "Second edit" })).toBeInTheDocument()

      // The content dismissed before the reload is a change again.
      await save(A, "# After edit\n")
      expect(await screen.findByText(NOTICE_TITLE)).toBeInTheDocument()
    })

    it("with --disable-live-file-reload, says Run keeps the commands approved at open", async () => {
      const { emit, save } = renderApp({ disableLiveFileReload: true })
      await openA(emit)

      await save(A, "# After edit\n")

      expect(await screen.findByText(NOTICE_TITLE)).toBeInTheDocument()
      expect(screen.getByText(/--disable-live-file-reload/)).toBeVisible()
      expect(screen.queryByText(/show and run the new version/)).not.toBeInTheDocument()
    })
  })

  describe("in a runbook with chapters", () => {
    const CHAPTERS =
      '<Chapter title="One">\n\n# Chapter one\n\n</Chapter>\n\n<Chapter title="Two">\n\n# Chapter two\n\n</Chapter>\n'
    const chapter = (name: string) => screen.getByRole("region", { name })
    const next = () =>
      fireEvent.click(
        within(screen.getByRole("navigation", { name: "Chapters" })).getByRole("button", {
          name: "Next chapter: Two",
        }),
      )

    async function openChapters(emit: ReturnType<typeof makeApi>["emit"]) {
      await emit("file:open-runbook", { path: A })
      expect(await screen.findByRole("heading", { name: "Chapter one" })).toBeInTheDocument()
    }

    it("shows the notice at the top of the chapter on screen only, and on the next one after Next", async () => {
      const { emit, save } = renderApp({
        content: CHAPTERS,
        finishedSession: { name: "brave-badger", finishedAt: new Date().toISOString() },
      })
      await openChapters(emit)
      const sessionNotice = await screen.findByText("New session elegant-elephant")

      await save(A, `${CHAPTERS}\nEdited.\n`)

      // Once, in the first chapter, above its content; not with the session notice.
      const changed = await screen.findByText(NOTICE_TITLE)
      expect(screen.getAllByText(NOTICE_TITLE)).toHaveLength(1)
      expect(within(chapter("One")).getByText(NOTICE_TITLE)).toBe(changed)
      expect(sessionNotice.compareDocumentPosition(changed)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(changed.compareDocumentPosition(screen.getByText("Chapter one"))).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      )

      next()

      const moved = await within(chapter("Two")).findByText(NOTICE_TITLE)
      expect(screen.getAllByText(NOTICE_TITLE)).toHaveLength(1)
      expect(moved.compareDocumentPosition(screen.getByText("Chapter two"))).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      )
      expect(screen.getByRole("heading", { name: "Chapter two" })).toBeInTheDocument()
    })

    it("dismissed on one chapter, stays dismissed on every chapter until a later change", async () => {
      const { emit, save } = renderApp({ content: CHAPTERS })
      await openChapters(emit)
      await save(A, `${CHAPTERS}\nEdited.\n`)
      await screen.findByText(NOTICE_TITLE)

      next()
      const notice = (await within(chapter("Two")).findByText(NOTICE_TITLE)).closest(
        '[role="status"]',
      )!
      fireEvent.click(within(notice as HTMLElement).getByRole("button", { name: "Dismiss" }))
      expect(screen.queryByText(NOTICE_TITLE)).not.toBeInTheDocument()

      fireEvent.click(
        within(screen.getByRole("navigation", { name: "Chapters" })).getByRole("button", {
          name: "Previous chapter: One",
        }),
      )
      expect(await screen.findByRole("heading", { name: "Chapter one" })).toBeVisible()
      expect(screen.queryByText(NOTICE_TITLE)).not.toBeInTheDocument()

      await save(A, `${CHAPTERS}\nEdited again.\n`)
      expect(await within(chapter("One")).findByText(NOTICE_TITLE)).toBeInTheDocument()
    })
  })

  it("with --watch, reloads at once and shows no notice", async () => {
    const { invoke, emit, save } = renderApp({ watchMode: true })
    await openA(emit)
    const loads = runbookGets(invoke).length

    await save(A, "# After edit\n")

    expect(await screen.findByRole("heading", { name: "After edit" })).toBeInTheDocument()
    await waitFor(() => expect(runbookGets(invoke)).toHaveLength(loads + 1))
    expect(runbookGets(invoke).at(-1)?.[1]).toMatchObject({ path: A, reload: true })
    expect(screen.queryByText(NOTICE_TITLE)).not.toBeInTheDocument()
  })

  it("with --watch, ignores a change to a runbook that is not the one on screen", async () => {
    const { invoke, emit, save } = renderApp({ watchMode: true })
    await openA(emit)
    const loads = runbookGets(invoke).length

    await save(B, "# Runbook B, edited\n")

    expect(runbookGets(invoke)).toHaveLength(loads)
    expect(screen.getByRole("heading", { name: "Before edit" })).toBeInTheDocument()
  })
})
