import { describe, it, expect, vi, beforeEach, type Mock } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import Command from "../Command"

// ---------------------------------------------------------------------------
// Mock useScriptExecution — controls all script-related state for Command
// ---------------------------------------------------------------------------

const defaultScriptExecution = {
  sourceCode: 'echo "hello"',
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
  status: "pending" as const,
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

// Mock useLogs since it's used indirectly
vi.mock("@/contexts/useLogs", () => ({
  useLogs: () => ({ registerLogs: vi.fn() }),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderCommand(props: Partial<React.ComponentProps<typeof Command>> = {}) {
  return render(
    <TestWrapper>
      <Command id="test-cmd" command='echo "hello"' {...props} />
    </TestWrapper>,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Command", () => {
  beforeEach(() => {
    mockScriptExecution = { ...defaultScriptExecution, execute: vi.fn(), cancel: vi.fn() }
  })

  // --- Rendering ---

  it("renders with minimal valid props", () => {
    renderCommand()
    expect(screen.getByTestId("test-cmd")).toBeInTheDocument()
  })

  it("renders title and description", () => {
    renderCommand({ title: "My Command", description: "Does something useful" })
    expect(screen.getByText("My Command")).toBeInTheDocument()
    expect(screen.getByText("Does something useful")).toBeInTheDocument()
  })

  it("shows default 'Run a command' label when no title and inline command", () => {
    renderCommand({ title: undefined })
    expect(screen.getByText("Run a command")).toBeInTheDocument()
  })

  it("shows default 'Run a script' label when no title and path-based", () => {
    mockScriptExecution = { ...defaultScriptExecution, execute: vi.fn(), cancel: vi.fn() }
    renderCommand({ command: undefined, path: "scripts/test.sh", title: undefined })
    expect(screen.getByText("Run a script")).toBeInTheDocument()
  })

  it("displays inline command content", () => {
    renderCommand({ command: 'echo "hello world"' })
    expect(screen.getByText('echo "hello"')).toBeInTheDocument() // sourceCode from mock
  })

  // --- Buttons ---

  it("has a Run button", () => {
    renderCommand()
    expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument()
  })

  it("Run button is enabled in pending state", () => {
    renderCommand()
    expect(screen.getByRole("button", { name: "Run" })).not.toBeDisabled()
  })

  it("Stop button is disabled in pending state", () => {
    renderCommand()
    expect(screen.getByRole("button", { name: /Stop/ })).toBeDisabled()
  })

  it("Run button is disabled while running", () => {
    mockScriptExecution = { ...defaultScriptExecution, status: "running", execute: vi.fn(), cancel: vi.fn() }
    renderCommand()
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled()
  })

  it("Stop button is enabled while running", () => {
    mockScriptExecution = { ...defaultScriptExecution, status: "running", execute: vi.fn(), cancel: vi.fn() }
    renderCommand()
    expect(screen.getByRole("button", { name: /Stop/ })).not.toBeDisabled()
  })

  it("clicking Run calls execute", async () => {
    const executeFn = vi.fn()
    mockScriptExecution = { ...defaultScriptExecution, execute: executeFn, cancel: vi.fn() }
    renderCommand()
    await userEvent.click(screen.getByRole("button", { name: "Run" }))
    expect(executeFn).toHaveBeenCalledOnce()
  })

  // --- Status messages ---

  it("shows success message on success", () => {
    mockScriptExecution = { ...defaultScriptExecution, status: "success", execute: vi.fn(), cancel: vi.fn() }
    renderCommand({ successMessage: "Command completed!" })
    expect(screen.getByText("Command completed!")).toBeInTheDocument()
  })

  it("shows fail message on failure", () => {
    mockScriptExecution = { ...defaultScriptExecution, status: "fail", execute: vi.fn(), cancel: vi.fn() }
    renderCommand({ failMessage: "Command failed!" })
    expect(screen.getByText("Command failed!")).toBeInTheDocument()
  })

  it("shows running message while running", () => {
    mockScriptExecution = { ...defaultScriptExecution, status: "running", execute: vi.fn(), cancel: vi.fn() }
    renderCommand({ runningMessage: "Please wait..." })
    expect(screen.getByText("Please wait...")).toBeInTheDocument()
  })

  // --- Status icons ---

  it("shows pending icon initially", () => {
    renderCommand()
    expect(screen.getByTestId("icon-pending")).toBeInTheDocument()
  })

  it("shows running icon when running", () => {
    mockScriptExecution = { ...defaultScriptExecution, status: "running", execute: vi.fn(), cancel: vi.fn() }
    renderCommand()
    expect(screen.getByTestId("icon-running")).toBeInTheDocument()
  })

  it("shows success icon on success", () => {
    mockScriptExecution = { ...defaultScriptExecution, status: "success", execute: vi.fn(), cancel: vi.fn() }
    renderCommand()
    expect(screen.getByTestId("icon-success")).toBeInTheDocument()
  })

  it("shows fail icon on failure", () => {
    mockScriptExecution = { ...defaultScriptExecution, status: "fail", execute: vi.fn(), cancel: vi.fn() }
    renderCommand()
    expect(screen.getByTestId("icon-fail")).toBeInTheDocument()
  })

  // --- Error states ---

  it("shows error display for missing id", () => {
    render(
      <TestWrapper>
        <Command id="" command="echo hi" />
      </TestWrapper>,
    )
    expect(screen.getByText(/requires a non-empty 'id' prop/)).toBeInTheDocument()
  })

  it("shows file error when script fails to load", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      fileError: { message: "File not found: scripts/missing.sh" },
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand({ path: "scripts/missing.sh", command: undefined })
    expect(screen.getByText(/File not found/)).toBeInTheDocument()
  })

  it("shows render error when template substitution fails", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      renderError: { message: "Variable 'region' is not defined" },
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand()
    expect(screen.getByText(/Variable 'region' is not defined/)).toBeInTheDocument()
  })

  it("shows exec error when script execution fails", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      execError: { message: "Script timed out" },
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand()
    expect(screen.getByText("Script timed out")).toBeInTheDocument()
  })

  // --- Dependencies ---

  it("disables Run when input dependencies are unmet", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      inputDependencies: ["region"],
      hasAllInputDependencies: false,
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    // Must provide inputsId to avoid the "Configuration Required" early return
    renderCommand({ inputsId: "some-inputs" })
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled()
  })

  it("disables Run when output dependencies are unmet", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      hasAllOutputDependencies: false,
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand()
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled()
  })

  it("disables Run when AWS auth dependency is unmet", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      hasAwsAuthDependency: false,
      unmetAwsAuthDependency: { blockId: "aws-auth" },
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand({ awsAuthId: "aws-auth" })
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled()
  })

  it("disables Run when GitHub auth dependency is unmet", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      hasGitHubAuthDependency: false,
      unmetGitHubAuthDependency: { blockId: "gh-auth" },
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand({ githubAuthId: "gh-auth" })
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled()
  })

  // --- Script metadata ---

  it("shows script metadata for path-based scripts", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      sourceCode: "#!/bin/bash\necho hello\necho world",
      language: "bash",
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand({ path: "scripts/test.sh", command: undefined })
    expect(screen.getByText("bash")).toBeInTheDocument()
    expect(screen.getByText("3")).toBeInTheDocument() // 3 lines
    expect(screen.getByText("scripts/test.sh")).toBeInTheDocument()
  })

  // --- Script drift ---

  it("shows drift warning when script changed on disk", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      hasScriptDrift: true,
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand({ path: "scripts/test.sh", command: undefined })
    expect(screen.getByText("Script changed")).toBeInTheDocument()
  })

  // --- Template resolution ---

  it("resolves template expressions in title", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      templateContext: { inputs: { env: "staging" }, outputs: {} },
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand({ title: "Deploy to {{ .inputs.env }}" })
    expect(screen.getByText("Deploy to staging")).toBeInTheDocument()
  })
})
