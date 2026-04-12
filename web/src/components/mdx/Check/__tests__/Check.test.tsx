import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import Check from "../Check"

// Mock useScriptExecution
const defaultScriptExecution = {
  sourceCode: 'echo "checking..."',
  language: "bash",
  fileError: null,
  inputValues: {},
  inputDependencies: [],
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

vi.mock("@/components/mdx/_shared/hooks/useScriptExecution", () => ({
  useScriptExecution: () => mockScriptExecution,
}))

vi.mock("@/contexts/useLogs", () => ({
  useLogs: () => ({ registerLogs: vi.fn() }),
}))

function renderCheck(props: Partial<React.ComponentProps<typeof Check>> = {}) {
  return render(
    <TestWrapper>
      <Check id="test-check" title="Test Check" command="exit 0" {...props} />
    </TestWrapper>,
  )
}

describe("Check", () => {
  beforeEach(() => {
    mockScriptExecution = { ...defaultScriptExecution, execute: vi.fn(), cancel: vi.fn() }
  })

  it("renders with valid props", () => {
    renderCheck()
    expect(screen.getByTestId("test-check")).toBeInTheDocument()
  })

  it("renders title and description", () => {
    renderCheck({ title: "Health Check", description: "Checks system health" })
    expect(screen.getByText("Health Check")).toBeInTheDocument()
    expect(screen.getByText("Checks system health")).toBeInTheDocument()
  })

  it("has a Check button (not Run)", () => {
    renderCheck()
    expect(screen.getByRole("button", { name: "Check" })).toBeInTheDocument()
  })

  it("clicking Check calls execute", async () => {
    const executeFn = vi.fn()
    mockScriptExecution = { ...defaultScriptExecution, execute: executeFn, cancel: vi.fn() }
    renderCheck()
    await userEvent.click(screen.getByRole("button", { name: "Check" }))
    expect(executeFn).toHaveBeenCalledOnce()
  })

  // --- Status icons ---

  it("shows pending icon initially", () => {
    renderCheck()
    expect(screen.getByTestId("icon-pending")).toBeInTheDocument()
  })

  it("shows success icon on success", () => {
    mockScriptExecution = { ...defaultScriptExecution, status: "success", execute: vi.fn(), cancel: vi.fn() }
    renderCheck()
    expect(screen.getByTestId("icon-success")).toBeInTheDocument()
  })

  it("shows warn icon on warn status (exit code 2)", () => {
    mockScriptExecution = { ...defaultScriptExecution, status: "warn", execute: vi.fn(), cancel: vi.fn() }
    renderCheck()
    expect(screen.getByTestId("icon-warn")).toBeInTheDocument()
  })

  it("shows fail icon on failure", () => {
    mockScriptExecution = { ...defaultScriptExecution, status: "fail", execute: vi.fn(), cancel: vi.fn() }
    renderCheck()
    expect(screen.getByTestId("icon-fail")).toBeInTheDocument()
  })

  // --- Status messages ---

  it("shows success message on success", () => {
    mockScriptExecution = { ...defaultScriptExecution, status: "success", execute: vi.fn(), cancel: vi.fn() }
    renderCheck({ successMessage: "All good!" })
    expect(screen.getByText("All good!")).toBeInTheDocument()
  })

  it("shows warn message on warn", () => {
    mockScriptExecution = { ...defaultScriptExecution, status: "warn", execute: vi.fn(), cancel: vi.fn() }
    renderCheck({ warnMessage: "Needs attention" })
    expect(screen.getByText("Needs attention")).toBeInTheDocument()
  })

  it("shows fail message on failure", () => {
    mockScriptExecution = { ...defaultScriptExecution, status: "fail", execute: vi.fn(), cancel: vi.fn() }
    renderCheck({ failMessage: "Check failed!" })
    expect(screen.getByText("Check failed!")).toBeInTheDocument()
  })

  it("shows running message while checking", () => {
    mockScriptExecution = { ...defaultScriptExecution, status: "running", execute: vi.fn(), cancel: vi.fn() }
    renderCheck({ runningMessage: "Verifying..." })
    expect(screen.getByText("Verifying...")).toBeInTheDocument()
  })

  // --- Error states ---

  it("shows error for missing id", () => {
    render(
      <TestWrapper>
        <Check id="" title="Bad" command="exit 0" />
      </TestWrapper>,
    )
    expect(screen.getByText(/requires a non-empty 'id' prop/)).toBeInTheDocument()
  })
})
