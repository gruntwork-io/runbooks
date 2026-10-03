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

const RUNBOOK = { path: "/work/a/runbook.mdx", content: "# Runbook A\n" }
const GENERATED_TREE = [{ id: "main.tf", name: "main.tf", type: "file", children: [] }]
const ALERT_TITLE = "Existing Generated Files Detected"

/**
 * A preload api whose runbook:get answers with `blockStates` for the session,
 * and whose generated-files:check finds 1 file, with its tree.
 */
function makeApi(blockStates: unknown[]) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const invoke = vi.fn(async (channel: string) => {
    switch (channel) {
      case "native:get-cli-config":
        return {}
      case "runbook:get":
        return {
          path: RUNBOOK.path,
          content: RUNBOOK.content,
          contentHash: RUNBOOK.path,
          language: "mdx",
          size: RUNBOOK.content.length,
          isWatchMode: false,
          warnings: [],
          sessionId: "session-0",
          sessionName: "elegant-elephant",
          sessionDir: "/sessions/dirs/session-0",
          blockStates,
        }
      case "generated-files:check":
        return {
          hasFiles: true,
          fileCount: 1,
          absoluteOutputPath: "/sessions/dirs/session-0/generated",
          relativeOutputPath: "generated",
          fileTree: GENERATED_TREE,
          totalFiles: 1,
          truncatedTree: false,
          heavyDirs: [],
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

async function openRunbook(blockStates: unknown[]) {
  const { api, emit } = makeApi(blockStates)
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
}

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

  it("asks about the generated files of a session with no history, and does not show them", async () => {
    await openRunbook([])

    expect(await screen.findByText(ALERT_TITLE)).toBeInTheDocument()
    for (const tree of screen.getAllByTestId("generated-tree")) {
      expect(tree.textContent).toBe("")
    }
  })
})
