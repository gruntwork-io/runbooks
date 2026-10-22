import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import Command from "../Command"
import { sensitiveOutput, type OutputValues } from "@/lib/outputValues"

// ---------------------------------------------------------------------------
// Mock useScriptExecution — controls all script-related state for Command
// ---------------------------------------------------------------------------

const defaultScriptExecution = {
  sourceCode: 'echo "hello"',
  language: "bash",
  fileError: null as { message: string; details?: string } | null,
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
  unmetAwsAuthDependency: null as { blockId: string } | null,
  hasAwsAuthDependency: true,
  unmetGitHubAuthDependency: null as { blockId: string } | null,
  hasGitHubAuthDependency: true,
  unmetGoogleAuthDependency: null as { blockId: string } | null,
  hasGoogleAuthDependency: true,
  isRendering: false,
  renderError: null as { message: string; details?: string } | null,
  status: "pending" as string,
  logs: [],
  execError: null as { message: string; details?: string } | null,
  execute: vi.fn(),
  cancel: vi.fn(),
  outputs: null as OutputValues | null,
  hasScriptDrift: false,
  scriptFileChange: null as {
    registeredContent: string
    diskContent: string
    diskContentHash: string
  } | null,
  reloadScript: vi.fn(),
  isReloadingScript: false,
  scriptReloadError: null as { message: string; details: string } | null,
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
    mockScriptExecution = {
      ...defaultScriptExecution,
      status: "running",
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand()
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled()
  })

  it("Stop button is enabled while running", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      status: "running",
      execute: vi.fn(),
      cancel: vi.fn(),
    }
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
    mockScriptExecution = {
      ...defaultScriptExecution,
      status: "success",
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand({ successMessage: "Command completed!" })
    expect(screen.getByText("Command completed!")).toBeInTheDocument()
  })

  it("shows fail message on failure", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      status: "fail",
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand({ failMessage: "Command failed!" })
    expect(screen.getByText("Command failed!")).toBeInTheDocument()
  })

  it("shows running message while running", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      status: "running",
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand({ runningMessage: "Please wait..." })
    expect(screen.getByText("Please wait...")).toBeInTheDocument()
  })

  // --- Status icons ---

  it("shows pending icon initially", () => {
    renderCommand()
    expect(screen.getByTestId("icon-pending")).toBeInTheDocument()
  })

  it("shows running icon when running", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      status: "running",
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand()
    expect(screen.getByTestId("icon-running")).toBeInTheDocument()
  })

  it("shows success icon on success", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      status: "success",
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand()
    expect(screen.getByTestId("icon-success")).toBeInTheDocument()
  })

  it("shows fail icon on failure", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      status: "fail",
      execute: vi.fn(),
      cancel: vi.fn(),
    }
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

  // An auth block supplies credentials, never `.inputs` values, so referencing
  // one doesn't stand in for an Inputs configuration.
  it.each([
    ["awsAuthId", { awsAuthId: "aws-auth" }],
    ["githubAuthId", { githubAuthId: "gh-auth" }],
    ["gitAuthId", { gitAuthId: "git-auth" }],
    ["googleAuthId", { googleAuthId: "gcp-auth" }],
  ])("shows Configuration Required for input references with only %s", (_prop, authProps) => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      inputDependencies: ["region"],
      hasAllInputDependencies: false,
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand(authProps)
    expect(screen.getByText(/Configuration Required/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull()
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

  it("disables Run and warns when the Google Cloud auth dependency is unmet", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      hasGoogleAuthDependency: false,
      unmetGoogleAuthDependency: { blockId: "gcp-auth" },
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand({ googleAuthId: "gcp-auth" })
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled()
    expect(screen.getByText(/Waiting for Google Cloud authentication/)).toBeInTheDocument()
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

  it("shows how a changed script file differs and reloads it on request", async () => {
    const reloadScript = vi.fn()
    mockScriptExecution = {
      ...defaultScriptExecution,
      hasScriptDrift: true,
      scriptFileChange: {
        registeredContent: "#!/bin/bash\necho before\n",
        diskContent: "#!/bin/bash\necho after\n",
        diskContentHash: "hash-after",
      },
      reloadScript,
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand({ path: "scripts/test.sh", command: undefined })

    // One notice, with the removed and the added line of the diff
    expect(screen.getAllByText("Script changed")).toHaveLength(1)
    const diff = screen.getByTestId("script-change-diff")
    expect(diff).toHaveTextContent("-echo before")
    expect(diff).toHaveTextContent("+echo after")

    await userEvent.click(screen.getByRole("button", { name: "Reload script" }))
    expect(reloadScript).toHaveBeenCalledTimes(1)
  })

  it("says so when a changed script file has no changed lines to show", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      hasScriptDrift: true,
      scriptFileChange: {
        registeredContent: "echo same\n",
        diskContent: "echo same\r\n",
        diskContentHash: "hash-crlf",
      },
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand({ path: "scripts/test.sh", command: undefined })

    expect(screen.queryByTestId("script-change-diff")).not.toBeInTheDocument()
    expect(screen.getByText(/differ only in line endings or a final newline/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload script" })).toBeEnabled()
  })

  it("shows why a script reload failed and disables the button while one is running", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      hasScriptDrift: true,
      scriptFileChange: {
        registeredContent: "echo a\n",
        diskContent: "echo b\n",
        diskContentHash: "hash-b",
      },
      isReloadingScript: true,
      scriptReloadError: {
        message: "scripts/test.sh changed again after you reviewed it.",
        details: "",
      },
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand({ path: "scripts/test.sh", command: undefined })

    expect(
      screen.getByText("scripts/test.sh changed again after you reviewed it."),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload script" })).toBeDisabled()
  })

  // --- Outputs ---

  it("masks outputs the script marked sensitive", () => {
    mockScriptExecution = {
      ...defaultScriptExecution,
      status: "success",
      outputs: { TOKEN: sensitiveOutput("topsecret"), user: "demo" },
      execute: vi.fn(),
      cancel: vi.fn(),
    }
    renderCommand()
    expect(screen.getByText("TOKEN")).toBeInTheDocument()
    expect(screen.queryByText("topsecret")).toBeNull()
    expect(screen.getByText("demo")).toBeInTheDocument()
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
