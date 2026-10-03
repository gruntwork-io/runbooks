import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, act } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { ThemeProvider } from "@/contexts/ThemeContext"
import { InstructionModeProvider } from "@/contexts/InstructionModeContext"
import { TelemetryContext, defaultContextValue } from "@/contexts/TelemetryContext.types"
import { ErrorReportingProvider } from "@/contexts/ErrorReportingContext"
import { GeneratedFilesProvider } from "@/contexts/GeneratedFilesContext"
import { IpcGitWorkTreeProvider } from "@/contexts/IpcGitWorkTreeContext"
import { LogsProvider } from "@/contexts/LogsContext"
import App from "../App"

// What App does with the generated files of a session it opens. The mock
// boundary is the preload API; the artifacts panel stands in for itself by
// showing the Generated tree it would render.
vi.mock("@/components/layout/ArtifactsContainer", async () => {
  const { useGeneratedFiles } = await import("@/hooks/useGeneratedFiles")
  return {
    ArtifactsContainer: () => {
      const { fileTree } = useGeneratedFiles()
      return (
        <div data-testid="generated-tree">
          {(fileTree ?? []).map((node) => node.name).join(",")}
        </div>
      )
    },
  }
})
vi.mock("@/components/layout/WelcomeScreen", () => ({
  WelcomeScreen: () => <div>Welcome</div>,
}))

/** Two runbooks, each with a session whose generated directory has one file. */
const RUNBOOKS = {
  "/work/a": { name: "A", session: "session-0", file: "main.tf" },
  "/work/b": { name: "B", session: "session-1", file: "b.tf" },
}
const ALERT_TITLE = "Existing Generated Files Detected"

/**
 * A preload api whose runbook:get answers with `blockStates` for the session,
 * and whose generated-files:check finds the last opened runbook's file, with
 * its tree. The check for runbook B waits for `bChecked`.
 */
function makeApi(blockStates: unknown[], bChecked: Promise<void> = Promise.resolve()) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  let current = RUNBOOKS["/work/a"]
  const invoke = vi.fn(async (channel: string, params?: { path?: string }) => {
    switch (channel) {
      case "native:get-cli-config":
        return {}
      case "runbook:get": {
        current = RUNBOOKS[params?.path as keyof typeof RUNBOOKS] ?? current
        const content = `# Runbook ${current.name}\n`
        return {
          path: `${params?.path}/runbook.mdx`,
          content,
          contentHash: current.name,
          language: "mdx",
          size: content.length,
          isWatchMode: false,
          warnings: [],
          sessionId: current.session,
          sessionName: "elegant-elephant",
          sessionDir: `/sessions/dirs/${current.session}`,
          blockStates,
        }
      }
      case "generated-files:check": {
        const checking = current
        if (checking === RUNBOOKS["/work/b"]) await bChecked
        return {
          hasFiles: true,
          fileCount: 1,
          absoluteOutputPath: `/sessions/dirs/${checking.session}/generated`,
          relativeOutputPath: "generated",
          fileTree: [{ id: checking.file, name: checking.file, type: "file", children: [] }],
          totalFiles: 1,
          truncatedTree: false,
          heavyDirs: [],
        }
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
  const api = { invoke, on } as unknown as Parameters<typeof ApiProvider>[0]["api"]
  return { api, emit }
}

const originalApi = window.api

async function openRunbook(blockStates: unknown[], bChecked?: Promise<void>) {
  const { api, emit } = makeApi(blockStates, bChecked)
  window.api = api
  render(
    <ApiProvider api={api}>
      <ThemeProvider>
        <InstructionModeProvider>
          <TelemetryContext.Provider value={defaultContextValue}>
            <ErrorReportingProvider>
              <GeneratedFilesProvider>
                <IpcGitWorkTreeProvider>
                  <LogsProvider>
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
  await emit("file:open-runbook", { path: "/work/a" })
  expect(
    await screen.findByRole("heading", { name: "Runbook A", hidden: true }),
  ).toBeInTheDocument()
  return emit
}

const RESUMED = [{ blockId: "vpc", kind: "inputs", payload: { values: {}, submitted: true } }]

const shownTrees = () => screen.getAllByTestId("generated-tree").map((tree) => tree.textContent)

describe("App opening a session with generated files", () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    window.api = originalApi
  })

  it("shows the files a resumed session's blocks wrote, and does not offer to delete them", async () => {
    await openRunbook([
      { blockId: "vpc", kind: "inputs", payload: { values: {}, submitted: true } },
    ])

    await waitFor(() =>
      expect(screen.getAllByTestId("generated-tree")[0]).toHaveTextContent("main.tf"),
    )
    expect(screen.queryByText(ALERT_TITLE)).not.toBeInTheDocument()
  })

  it("shows a resumed session's own files, never the previous session's", async () => {
    let releaseB!: () => void
    const bChecked = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    const emit = await openRunbook(RESUMED, bChecked)
    await waitFor(() => expect(shownTrees()).toContain("main.tf"))

    await emit("file:open-runbook", { path: "/work/b" })
    await screen.findByRole("heading", { name: "Runbook B", hidden: true })
    // B's files are still being read: A's must not stand in for them.
    expect(shownTrees()).not.toContain("main.tf")

    await act(async () => releaseB())
    await waitFor(() => expect(shownTrees()).toContain("b.tf"))
    expect(shownTrees()).not.toContain("main.tf")
  })

  it("asks about the generated files of a session with no history, and does not show them", async () => {
    await openRunbook([])

    expect(await screen.findByText(ALERT_TITLE)).toBeInTheDocument()
    for (const tree of screen.getAllByTestId("generated-tree")) {
      expect(tree.textContent).toBe("")
    }
  })
})
