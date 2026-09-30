import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import Finish from "../Finish"
import { celebrate } from "../celebrate"

const defaultScriptExecution = {
  sourceCode: 'test -f done.txt',
  rawScriptContent: 'test -f done.txt',
  language: "bash",
  fileError: null,
  inputValues: {},
  inputDependencies: [] as string[],
  unmetInputDependencies: [],
  hasAllInputDependencies: true,
  inlineInputsId: null,
  outputDependencies: [],
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
}

let mockScriptExecution = { ...defaultScriptExecution }
// Captures the props Finish passes to useScriptExecution, to assert wiring the
// mock would otherwise hide (the hook maps warn to fail for a 'command').
let lastScriptExecutionProps: Record<string, unknown> | null = null

vi.mock("@/components/mdx/_shared/hooks/useScriptExecution", () => ({
  useScriptExecution: (props: Record<string, unknown>) => {
    lastScriptExecutionProps = props
    return mockScriptExecution
  },
}))

vi.mock("@/contexts/useLogs", () => ({
  useLogs: () => ({ registerLogs: vi.fn() }),
}))

// jsdom has no canvas; the celebration itself is covered by celebrate.test.ts.
vi.mock("../celebrate", () => ({ celebrate: vi.fn() }))

function setStatus(status: string) {
  mockScriptExecution = { ...mockScriptExecution, status }
}

function finish(props: Partial<React.ComponentProps<typeof Finish>> = {}) {
  return (
    <TestWrapper>
      <Finish id="finish" {...props}>
        <p>Next: tell your team.</p>
      </Finish>
    </TestWrapper>
  )
}

describe("Finish", () => {
  beforeEach(() => {
    mockScriptExecution = { ...defaultScriptExecution, execute: vi.fn(), cancel: vi.fn() }
    lastScriptExecutionProps = null
    vi.mocked(celebrate).mockClear()
  })

  describe("without a final check", () => {
    it("shows a Finish button and nothing a script would need", () => {
      render(finish())

      expect(screen.getByText("Finish this runbook")).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Finish" })).toBeEnabled()
      expect(screen.queryByRole("button", { name: /stop/i })).toBeNull()
      expect(screen.queryByText("View Logs")).toBeNull()
      expect(screen.getByTestId("icon-pending")).toBeInTheDocument()
    })

    it("keeps the next steps hidden until the runbook is finished", () => {
      render(finish())
      expect(screen.queryByText("Next: tell your team.")).toBeNull()
      expect(screen.queryByText("You finished this runbook!")).toBeNull()
    })

    it("finishes on click, without running anything: success, next steps and one celebration", async () => {
      render(finish())

      await userEvent.click(screen.getByRole("button", { name: "Finish" }))

      expect(screen.getByTestId("icon-success")).toBeInTheDocument()
      expect(screen.getByText("You finished this runbook!")).toBeInTheDocument()
      expect(screen.getByText("Next: tell your team.")).toBeInTheDocument()
      expect(celebrate).toHaveBeenCalledOnce()
      expect(mockScriptExecution.execute).not.toHaveBeenCalled()
      expect(screen.getByRole("button", { name: "Finish" })).toBeDisabled()
    })

    it("uses the author's title and messages", async () => {
      render(finish({ title: "All done", successMessage: "Nice work!" }))

      await userEvent.click(screen.getByRole("button", { name: "Finish" }))

      expect(screen.getByText("All done")).toBeInTheDocument()
      expect(screen.getByText("Nice work!")).toBeInTheDocument()
    })
  })

  describe("with a final check", () => {
    it("runs the check on click, and shows its logs and a Stop button", async () => {
      render(finish({ command: "test -f done.txt" }))

      expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument()
      expect(screen.getByText("View Logs")).toBeInTheDocument()

      await userEvent.click(screen.getByRole("button", { name: "Finish" }))

      expect(mockScriptExecution.execute).toHaveBeenCalledOnce()
      expect(celebrate).not.toHaveBeenCalled()
    })

    it("celebrates and shows the next steps once the check passes", () => {
      const { rerender } = render(finish({ command: "test -f done.txt" }))
      setStatus("running")
      rerender(finish({ command: "test -f done.txt" }))
      expect(screen.getByText("Running the final check...")).toBeInTheDocument()
      expect(celebrate).not.toHaveBeenCalled()

      setStatus("success")
      rerender(finish({ command: "test -f done.txt" }))

      expect(screen.getByText("You finished this runbook!")).toBeInTheDocument()
      expect(screen.getByText("Next: tell your team.")).toBeInTheDocument()
      expect(celebrate).toHaveBeenCalledOnce()
    })

    it.each([
      { status: "fail", message: /The final check failed/ },
      { status: "warn", message: /^Warning$/ },
    ])("doesn't celebrate or show the next steps when the check ends in $status", ({ status, message }) => {
      const { rerender } = render(finish({ command: "test -f done.txt" }))
      setStatus("running")
      rerender(finish({ command: "test -f done.txt" }))
      setStatus(status)
      rerender(finish({ command: "test -f done.txt" }))

      expect(screen.getByTestId(`icon-${status}`)).toBeInTheDocument()
      expect(screen.getByText(message)).toBeInTheDocument()
      expect(screen.queryByText("Next: tell your team.")).toBeNull()
      expect(celebrate).not.toHaveBeenCalled()
    })

    it("runs the final check as a check, so an exit code 2 stays a warning rather than a failure", () => {
      render(finish({ command: "test -f done.txt" }))
      expect(lastScriptExecutionProps).toMatchObject({ componentType: "check" })
    })

    it("celebrates again when a re-run passes", () => {
      const { rerender } = render(finish({ command: "test -f done.txt" }))
      for (const status of ["running", "success", "running", "success"]) {
        setStatus(status)
        rerender(finish({ command: "test -f done.txt" }))
      }
      expect(celebrate).toHaveBeenCalledTimes(2)
    })

    it("doesn't celebrate a block that mounts already finished", () => {
      setStatus("success")
      render(finish({ command: "test -f done.txt" }))

      expect(screen.getByText("Next: tell your team.")).toBeInTheDocument()
      expect(celebrate).not.toHaveBeenCalled()
    })

    it("asks for an inputsId, not a nested <Inputs>, when the check needs input values", () => {
      mockScriptExecution = {
        ...mockScriptExecution,
        inputDependencies: ["Env"],
        hasAllInputDependencies: false,
      }
      render(finish({ command: 'test "{{ .inputs.Env }}" = prod' }))

      expect(screen.getByText(/Configuration Required/)).toBeInTheDocument()
      const message = screen.getByText(/final check requires variables \(Env\)/)
      expect(message).toHaveTextContent(/Please add an inputsId prop referencing an existing Inputs block\.$/)
      expect(within(message).queryByRole("list")).toBeNull()
      expect(screen.queryByText(/as a child/)).toBeNull()
    })
  })

  it("shows an error for a missing id", () => {
    render(
      <TestWrapper>
        <Finish id="" />
      </TestWrapper>,
    )
    expect(screen.getByText(/The <Finish> component requires a non-empty 'id' prop/)).toBeInTheDocument()
  })
})
