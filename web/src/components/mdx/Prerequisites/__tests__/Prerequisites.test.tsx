import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ApiProvider, type RunbooksAPI } from "@/contexts/ApiContext"
import { IpcSessionHistoryProvider } from "@/contexts/IpcSessionHistoryContext"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useAllOutputs } from "@/contexts/useRunbook"
import { revealOutputs } from "@/lib/outputValues"
import { RunbookProgressProbe, TestWrapper } from "@/test/test-utils"
import type { SavedBlockState } from "../../../../../../src/domain/session/history"
import Prerequisites from "../Prerequisites"

// The block under the real exec hook, session history and runbook context.
// The mock boundary is the preload API: exec:run's result comes from the
// test, as the main process's check would send it.
vi.mock("@/hooks/useExecutableRegistry", () => {
  const registry = {
    getExecutableByComponentId: (componentId: string) =>
      componentId === "unregistered" ? undefined : { id: `exec-${componentId}`, componentId },
    registryVersion: 0,
  }
  return { useExecutableRegistry: () => registry }
})
vi.mock("@/contexts/useLogs", () => {
  const ctx = { registerLogs: () => {} }
  return { useLogs: () => ctx }
})

let mockInstructionMode = false
vi.mock("@/contexts/useInstructionMode", () => ({
  useInstructionMode: () => ({ enabled: mockInstructionMode, setEnabled: () => {} }),
}))

const TOOLS = `tools:
  - git
  - name: tofu
    version: ">= 1.6"
    install: "[Install OpenTofu](https://opentofu.org/docs/intro/install/)"
  - name: gh
    description: Opens the pull request.
    optional: true
    install: Run \`brew install gh\`.
`

let invoke: ReturnType<typeof vi.fn>
let api: RunbooksAPI
/** Ends the exec:run in flight, as the main process does with its result. */
let endRun: (result: unknown) => void

beforeEach(() => {
  mockInstructionMode = false
  invoke = vi.fn((channel: string) => {
    if (channel === "exec:run") {
      return new Promise((resolve) => {
        endRun = resolve
      })
    }
    return Promise.resolve({ ok: true })
  })
  api = { invoke, on: () => () => {} } as unknown as RunbooksAPI
})

afterEach(() => {
  cleanup()
})

/** What exec:run resolves with for a check that ended as `status` with `outputs`. */
function finished(status: "success" | "warn" | "fail", outputs: Record<string, string>) {
  const exitCode = { success: 0, warn: 2, fail: 1 }[status]
  return {
    status: { status, exitCode },
    outputs: Object.fromEntries(
      Object.entries(outputs).map(([key, value]) => [key, { value, sensitive: false }]),
    ),
  }
}

/** Shows the outputs the block published for other blocks, if any. */
function PublishedOutputs() {
  const outputs = useAllOutputs()
  return (
    <div data-testid="published-outputs">
      {JSON.stringify(outputs.tools ? revealOutputs(outputs.tools.values) : null)}
    </div>
  )
}

function ReportedErrors() {
  const { errors } = useErrorReporting()
  return (
    <ul data-testid="reported-errors">
      {errors.map((e) => (
        <li key={e.componentId}>{e.message}</li>
      ))}
    </ul>
  )
}

const published = () => JSON.parse(screen.getByTestId("published-outputs").textContent ?? "null")
const reportedErrors = () =>
  Array.from(screen.getByTestId("reported-errors").children, (li) => li.textContent)

function renderBlock({
  id = "tools",
  toolList = TOOLS as string | null,
  saved,
}: { id?: string; toolList?: string | null; saved?: unknown } = {}) {
  const blockStates: SavedBlockState[] =
    saved === undefined ? [] : [{ blockId: id, kind: "run", payload: saved }]
  return render(
    <ApiProvider api={api}>
      <IpcSessionHistoryProvider sessionId="s1" blockStates={blockStates}>
        <TestWrapper>
          <Prerequisites id={id}>
            {toolList === null ? undefined : (
              <pre>
                <code className="language-yaml">{toolList}</code>
              </pre>
            )}
          </Prerequisites>
          <PublishedOutputs />
          <ReportedErrors />
          <RunbookProgressProbe />
        </TestWrapper>
      </IpcSessionHistoryProvider>
    </ApiProvider>,
  )
}

const row = (name: string) => screen.getByTestId(`tool-${name}`)

describe("Prerequisites", () => {
  it("lists the tools, unchecked, until the user checks them", () => {
    renderBlock()

    expect(screen.getByText("Tools this runbook needs")).toBeInTheDocument()
    expect(screen.getByTestId("icon-pending")).toBeInTheDocument()
    expect(row("git")).toHaveAttribute("data-status", "unchecked")
    expect(within(row("tofu")).getByText(">= 1.6")).toBeInTheDocument()
    expect(within(row("gh")).getByText("optional")).toBeInTheDocument()
    expect(within(row("gh")).getByText("Opens the pull request.")).toBeInTheDocument()
    // Install hints are for the tools a check finds a problem with. Until
    // then they keep their space, as the status messages do, so the tools
    // don't move when the check ends.
    expect(screen.getByText("Install OpenTofu")).not.toBeVisible()
    expect(screen.getByText("Checking the tools...")).not.toBeVisible()
    expect(screen.getByRole("button", { name: "Check" })).toBeEnabled()
    expect(invoke).not.toHaveBeenCalledWith("exec:run", expect.anything())
  })

  it("checks in the main process, then marks each tool and says how to fix the missing ones", async () => {
    renderBlock()

    await userEvent.click(screen.getByRole("button", { name: "Check" }))

    expect(invoke).toHaveBeenCalledWith(
      "exec:run",
      expect.objectContaining({ executableId: "exec-tools" }),
    )
    expect(screen.getByTestId("icon-running")).toBeInTheDocument()
    expect(screen.getByText("Checking the tools...")).toBeVisible()

    await act(async () =>
      endRun(
        finished("fail", {
          git_path: "/usr/bin/git",
          tofu_path: "/opt/homebrew/bin/tofu",
          tofu_version: "1.5.7",
          gh_path: "",
        }),
      ),
    )

    expect(screen.getByTestId("icon-fail")).toBeInTheDocument()
    expect(
      screen.getByText("Install or update the tools marked below, then check again."),
    ).toBeVisible()
    expect(screen.getByText("Checking the tools...")).not.toBeVisible()
    expect(row("git")).toHaveAttribute("data-status", "found")
    expect(row("git")).toHaveTextContent("Found at /usr/bin/git")
    expect(row("tofu")).toHaveAttribute("data-status", "wrong_version")
    expect(row("tofu")).toHaveTextContent("1.5.7 at /opt/homebrew/bin/tofu doesn't meet >= 1.6.")
    expect(within(row("tofu")).getByRole("link", { name: "Install OpenTofu" })).toBeVisible()
    expect(row("gh")).toHaveAttribute("data-status", "missing")
    expect(row("gh")).toHaveTextContent("Not found on PATH.")
    expect(within(row("gh")).getByText("brew install gh")).toBeVisible()
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled()
    // The logs stay closed, so the block doesn't grow when a check runs.
    expect(screen.getByRole("button", { name: "View Logs" })).toHaveAttribute(
      "aria-expanded",
      "false",
    )
  })

  it("marks a tool it found differently from a check that passed", async () => {
    renderBlock()

    await userEvent.click(screen.getByRole("button", { name: "Check" }))
    await act(async () =>
      endRun(
        finished("success", {
          git_path: "/usr/bin/git",
          tofu_path: "/bin/tofu",
          tofu_version: "1.8.2",
          gh_path: "/bin/gh",
        }),
      ),
    )

    const blockIcon = screen.getByTestId("icon-success")
    const toolMark = row("git").querySelector("svg")
    expect(toolMark).toHaveClass("text-success")
    expect(toolMark?.innerHTML).not.toBe(blockIcon.innerHTML)
  })

  it("publishes its outputs for other blocks when the check passes or warns, and withdraws them when it fails", async () => {
    renderBlock()

    await userEvent.click(screen.getByRole("button", { name: "Check" }))
    await act(async () =>
      endRun(
        finished("warn", {
          git_path: "/usr/bin/git",
          tofu_path: "/bin/tofu",
          tofu_version: "1.8.2",
          gh_path: "",
        }),
      ),
    )

    expect(screen.getByTestId("icon-warn")).toBeInTheDocument()
    expect(row("gh")).toHaveAttribute("data-status", "missing")
    expect(row("tofu")).toHaveTextContent("1.8.2 at /bin/tofu")
    expect(published()).toEqual({
      git_path: "/usr/bin/git",
      tofu_path: "/bin/tofu",
      tofu_version: "1.8.2",
      gh_path: "",
    })
    expect(screen.getByRole("button", { name: "View Outputs (4)" })).toBeVisible()

    await userEvent.click(screen.getByRole("button", { name: "Check again" }))
    await act(async () =>
      endRun(finished("fail", { git_path: "", tofu_path: "/bin/tofu", tofu_version: "1.8.2" })),
    )

    expect(row("git")).toHaveAttribute("data-status", "missing")
    expect(published()).toEqual({})
    // The outputs bar keeps its space, hidden, so the block doesn't shrink.
    expect(screen.getByText(/^View Outputs/)).not.toBeVisible()
  })

  it("counts as a step of the runbook, done while only optional tools are missing", async () => {
    renderBlock()
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("0/1")

    await userEvent.click(screen.getByRole("button", { name: "Check" }))
    await act(async () =>
      endRun(
        finished("warn", {
          git_path: "/usr/bin/git",
          tofu_path: "/bin/tofu",
          tofu_version: "1.8.2",
          gh_path: "",
        }),
      ),
    )
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("1/1")

    await userEvent.click(screen.getByRole("button", { name: "Check again" }))
    await act(async () =>
      endRun(finished("fail", { git_path: "", tofu_path: "/bin/tofu", tofu_version: "1.8.2" })),
    )
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("0/1")
  })

  it("starts from the last run in the session's history, without checking again", () => {
    const saved = {
      status: "fail",
      exitCode: 1,
      logs: [{ line: "tofu: not found on PATH.", timestamp: "2026-01-01T00:00:00.000Z" }],
      omittedLogLines: 0,
      logFile: null,
      outputs: {
        git_path: { value: "/usr/bin/git", sensitive: false },
        tofu_path: { value: "", sensitive: false },
        gh_path: { value: "/usr/local/bin/gh", sensitive: false },
      },
      outputsOmitted: false,
      error: null,
    }

    renderBlock({ saved })

    expect(screen.getByTestId("icon-fail")).toBeInTheDocument()
    expect(row("tofu")).toHaveAttribute("data-status", "missing")
    expect(row("gh")).toHaveAttribute("data-status", "found")
    expect(published()).toEqual({})
    expect(invoke).not.toHaveBeenCalledWith("exec:run", expect.anything())
  })

  it("explains a block whose tool list isn't in the registry, instead of running nothing", async () => {
    renderBlock({ id: "unregistered" })

    await userEvent.click(screen.getByRole("button", { name: "Check" }))

    expect(screen.getByText('Runbooks has no tool list for "unregistered"')).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith("exec:run", expect.anything())
  })

  describe("a configuration error", () => {
    it("is shown, and reported, for a block without a tool list", () => {
      renderBlock({ toolList: null })

      const message = 'The <Prerequisites id="tools"> block needs its tool list in a code fence'
      expect(screen.getByTestId("component-error")).toHaveTextContent(message)
      expect(screen.getByTestId("component-error")).toHaveTextContent(
        "with a `tools:` list inside the block, and nothing else.",
      )
      expect(reportedErrors()).toEqual([message])
      expect(screen.queryByRole("button", { name: "Check" })).toBeNull()
    })

    it("is shown, with the parser's reason, for an invalid tool list", () => {
      renderBlock({ toolList: "tools:\n  - name: tofu\n    versions: '>= 1.6'\n" })

      const error = screen.getByTestId("component-error")
      expect(error).toHaveTextContent('The <Prerequisites id="tools"> tool list is invalid')
      expect(error).toHaveTextContent('"tofu" has an unknown key "versions".')
      expect(reportedErrors()).toEqual(['The <Prerequisites id="tools"> tool list is invalid'])
    })

    it("leaves the block out of the runbook's steps", () => {
      renderBlock({ toolList: null })
      expect(screen.getByTestId("runbook-progress")).toHaveTextContent("0/0")
    })
  })

  describe("an anyOf list", () => {
    const LISTS = `tools:
  - git
  - anyOf:
      - name: gh
        install: Run \`brew install gh\`.
      - name: glab
        install: Run \`brew install glab\`.
    description: Opens the pull or merge request.
`
    const anyOf = () => screen.getByTestId("any-of-gh-glab")
    /** The red mark of a tool the runbook needs and the check didn't find. */
    const failMark = (name: string) => row(name).querySelector("svg.text-destructive")

    async function check(status: "success" | "fail", outputs: Record<string, string>) {
      await userEvent.click(screen.getByRole("button", { name: "Check" }))
      await act(async () => endRun(finished(status, outputs)))
    }

    it("lists its tools under one heading", () => {
      renderBlock({ toolList: LISTS })

      expect(anyOf()).toHaveAttribute("data-status", "unchecked")
      expect(within(anyOf()).getByText("Any one of these")).toBeInTheDocument()
      expect(within(anyOf()).getByText("Opens the pull or merge request.")).toBeInTheDocument()
      expect(within(anyOf()).getByTestId("tool-gh")).toHaveAttribute("data-status", "unchecked")
      expect(within(anyOf()).getByTestId("tool-glab")).toHaveAttribute("data-status", "unchecked")
    })

    it("is met by one of its tools, and doesn't mark the others as problems", async () => {
      renderBlock({ toolList: LISTS })

      await check("success", { git_path: "/usr/bin/git", gh_path: "", glab_path: "/bin/glab" })

      expect(anyOf()).toHaveAttribute("data-status", "met")
      expect(row("glab")).toHaveAttribute("data-status", "found")
      expect(row("gh")).toHaveAttribute("data-status", "missing")
      expect(row("gh")).toHaveTextContent("Not found on PATH.")
      expect(failMark("gh")).toBeNull()
      expect(screen.getByText("brew install gh")).not.toBeVisible()
    })

    it("marks each of its tools, with its install hint, when none is found", async () => {
      renderBlock({ toolList: LISTS })

      await check("fail", { git_path: "/usr/bin/git", gh_path: "", glab_path: "" })

      expect(anyOf()).toHaveAttribute("data-status", "unmet")
      for (const name of ["gh", "glab"]) {
        expect(failMark(name)).not.toBeNull()
        expect(within(row(name)).getByText(`brew install ${name}`)).toBeVisible()
      }
    })

    it("is checked in instruction mode by one line that succeeds when any of its tools is installed", () => {
      mockInstructionMode = true
      renderBlock({ toolList: LISTS })

      const instruction = screen.getByTestId("instruction-tools")
      expect(within(instruction).getByText("Any one of these")).toBeVisible()
      expect(within(instruction).getByText("brew install glab")).toBeVisible()
      expect(instruction.querySelector("code.language-bash")?.textContent).toBe(
        "command -v git\ncommand -v gh || command -v glab",
      )
    })
  })

  describe("in instruction mode", () => {
    beforeEach(() => {
      mockInstructionMode = true
    })

    it("lists the tools with every install hint, and the commands that check them, and runs nothing", () => {
      renderBlock()

      const instruction = screen.getByTestId("instruction-tools")
      expect(within(instruction).getByText("Make sure these tools are installed:")).toBeVisible()
      expect(within(instruction).getByRole("link", { name: "Install OpenTofu" })).toBeVisible()
      expect(within(instruction).getByText("brew install gh")).toBeVisible()
      expect(instruction.querySelector("code.language-bash")?.textContent).toBe(
        "command -v git\ntofu --version\ncommand -v gh",
      )
      expect(screen.queryByRole("button", { name: "Check" })).toBeNull()
      expect(invoke).not.toHaveBeenCalledWith("exec:run", expect.anything())
    })
  })
})
