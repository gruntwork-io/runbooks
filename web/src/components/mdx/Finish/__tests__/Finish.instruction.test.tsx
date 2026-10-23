import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, within } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import { SessionHistoryContext } from "@/contexts/SessionHistoryContext.types"
import Finish from "../Finish"
import { celebrate } from "../celebrate"

const baseExecution = {
  sourceCode: "",
  rawScriptContent: "",
  language: "bash",
  fileError: null,
  envTemplates: {},
  envVars: [],
  envError: null,
  inputValues: {},
  inputDependencies: [] as string[],
  unmetInputDependencies: [],
  hasAllInputDependencies: true,
  inlineInputsId: null,
  outputDependencies: [],
  outputDependencyBlockIds: [] as string[],
  unmetOutputDependencies: [],
  hasAllOutputDependencies: true,
  templateContext: { inputs: {}, outputs: {} },
  unmetAwsAuthDependency: null,
  hasAwsAuthDependency: true,
  unmetGitHubAuthDependency: null,
  hasGitHubAuthDependency: true,
  unmetGoogleAuthDependency: null,
  hasGoogleAuthDependency: true,
  isRendering: false,
  renderError: null,
  status: "pending" as string,
  logs: [],
  execError: null,
  execute: vi.fn(),
  cancel: vi.fn(),
  outputs: null,
  hasScriptDrift: false,
  scriptFileChange: null,
  reloadScript: vi.fn(),
  isReloadingScript: false,
  scriptReloadError: null,
}

let mockExecution = { ...baseExecution }
vi.mock("@/components/mdx/_shared/hooks/useScriptExecution", () => ({
  useScriptExecution: () => mockExecution,
}))

vi.mock("@/contexts/useLogs", () => ({
  useLogs: () => ({ registerLogs: vi.fn() }),
}))

vi.mock("@/contexts/useInstructionMode", () => ({
  useInstructionMode: () => ({ enabled: true, setEnabled: vi.fn() }),
}))

vi.mock("../celebrate", () => ({ celebrate: vi.fn() }))

const history = { saved: vi.fn(), record: vi.fn(), finish: vi.fn() }

function renderFinish(props: Partial<React.ComponentProps<typeof Finish>> = {}) {
  return render(
    <TestWrapper>
      <SessionHistoryContext.Provider value={history}>
        <Finish id="finish" {...props}>
          <p>Next: tell your team.</p>
        </Finish>
      </SessionHistoryContext.Provider>
    </TestWrapper>,
  )
}

describe("Finish — instruction mode", () => {
  beforeEach(() => {
    mockExecution = { ...baseExecution, execute: vi.fn(), cancel: vi.fn() }
    vi.mocked(celebrate).mockClear()
    history.finish.mockClear()
    localStorage.clear()
  })

  it("shows the title and next steps, with no code block, when there is no final check", () => {
    renderFinish()

    const instruction = screen.getByTestId("instruction-finish")
    expect(within(instruction).getByText("Finish this runbook")).toBeInTheDocument()
    expect(within(instruction).getByText("Next: tell your team.")).toBeInTheDocument()
    expect(instruction.querySelector("code")).toBeNull()
    expect(screen.queryByRole("button", { name: "Finish" })).toBeNull()
  })

  it("shows the final check as a command to run", () => {
    mockExecution = { ...mockExecution, rawScriptContent: "test -f done.txt" }
    renderFinish({ command: "test -f done.txt" })

    expect(screen.getByText("test -f done.txt")).toBeInTheDocument()
    expect(screen.getByText("Next: tell your team.")).toBeInTheDocument()
  })

  it("celebrates and marks the session finished when marked done, not when un-marked, and never runs anything", () => {
    renderFinish()

    fireEvent.click(screen.getByRole("button", { name: /mark step as done/i }))
    expect(celebrate).toHaveBeenCalledOnce()
    expect(history.finish).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole("button", { name: /mark step as not done/i }))
    expect(celebrate).toHaveBeenCalledOnce()
    expect(history.finish).toHaveBeenCalledOnce()
    expect(mockExecution.execute).not.toHaveBeenCalled()
  })
})
