import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { RunbookProgressProbe, TestWrapper } from "@/test/test-utils"
import Command from "../Command"
import { Inputs } from "@/components/mdx/Inputs"
import { useRunbookContext } from "@/contexts/useRunbook"
import type { BoilerplateConfig } from "@/types/boilerplateConfig"

// Control the shared execution hook so we drive rawScriptContent + context.
const baseExecution = {
  sourceCode: "",
  rawScriptContent: "echo hello",
  language: "bash",
  fileError: null,
  envTemplates: {} as Record<string, string>,
  envVars: [] as Array<{ name: string; value: string }>,
  envError: null as string | null,
  inputValues: {},
  inputDependencies: [] as string[],
  unmetInputDependencies: [],
  hasAllInputDependencies: true,
  inlineInputsId: null as string | null,
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
// With an inline Inputs, templateContext comes from the real RunbookContext (as
// in the real hook), so values entered in the embedded form reach the command.
vi.mock("@/components/mdx/_shared/hooks/useScriptExecution", async () => {
  const { useRunbookContext: useRealRunbookContext } = await import("@/contexts/useRunbook")
  return {
    useScriptExecution: () => {
      const { getTemplateContext } = useRealRunbookContext()
      return mockExecution.inlineInputsId
        ? { ...mockExecution, templateContext: getTemplateContext(mockExecution.inlineInputsId) }
        : mockExecution
    },
  }
})

// Config for the nested <Inputs>: one variable with no default.
const inputsConfig = {
  data: {
    variables: [{ name: "Env", type: "string", description: "Target environment" }],
    outputDependencies: [],
  } as BoilerplateConfig,
  isLoading: false,
  error: null,
  refetch: vi.fn(),
  silentRefetch: vi.fn(),
}
vi.mock("@/hooks/useApiGetBoilerplateConfig", () => ({
  useApiGetBoilerplateConfig: () => inputsConfig,
}))

vi.mock("@/contexts/useLogs", () => ({
  useLogs: () => ({ registerLogs: vi.fn() }),
}))

let mockEnabled = true
vi.mock("@/contexts/useInstructionMode", () => ({
  useInstructionMode: () => ({ enabled: mockEnabled, setEnabled: vi.fn() }),
}))

function renderCommand(props: Partial<React.ComponentProps<typeof Command>> = {}) {
  return render(
    <TestWrapper>
      <Command id="test-cmd" command="echo hello" {...props} />
    </TestWrapper>,
  )
}

describe("Command — instruction mode", () => {
  beforeEach(() => {
    mockExecution = { ...baseExecution }
    mockEnabled = true
    // Where a step's "Mark as done" is kept
    localStorage.clear()
  })

  it("renders a copyable command and no Run button when the flag is on", () => {
    mockExecution.rawScriptContent = "echo hello"
    renderCommand()
    expect(screen.getByText("echo hello")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^run$/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /stop/i })).toBeNull()
  })

  it("resolves input references from the form context", () => {
    mockExecution.rawScriptContent = "echo {{ .inputs.name }}"
    mockExecution.templateContext = { inputs: { name: "world" }, outputs: {} }
    renderCommand({ command: "echo {{ .inputs.name }}" })
    expect(screen.getByText("echo world")).toBeInTheDocument()
    expect(screen.queryByText(/\{\{/)).toBeNull()
  })

  it("auto-detects an output reference as a manual field and resolves once filled", async () => {
    mockExecution.rawScriptContent = "echo {{ .outputs.create_account.account_id }}"
    renderCommand({ command: "echo {{ .outputs.create_account.account_id }}" })

    const field = screen.getByPlaceholderText(/paste the account_id value/i)
    expect(field).toBeInTheDocument()
    expect(screen.queryByText(/\{\{/)).toBeNull()

    fireEvent.change(field, { target: { value: "123456789012" } })
    await waitFor(() => expect(screen.getByText("echo 123456789012")).toBeInTheDocument())
  })

  it("renders a nested Inputs form and resolves the command from what the user enters", async () => {
    mockExecution.rawScriptContent = "deploy --env {{ .inputs.Env }}"
    mockExecution.inputDependencies = ["Env"]
    mockExecution.inlineInputsId = "deploy-inputs"
    render(
      <TestWrapper>
        <Command id="test-cmd" command="deploy --env {{ .inputs.Env }}">
          <Inputs id="deploy-inputs" path="boilerplate.yml" />
        </Command>
      </TestWrapper>,
    )

    const block = screen.getByTestId("instruction-test-cmd")
    const field = within(block).getByTestId("field-Env").querySelector("input")!
    // Not filled in yet: the command shows a placeholder, not a raw template.
    await waitFor(() => expect(within(block).getByText("deploy --env <Env>")).toBeInTheDocument())

    fireEvent.change(field, { target: { value: "prod" } })
    await waitFor(() => expect(within(block).getByText("deploy --env prod")).toBeInTheDocument())
    expect(block.textContent).not.toContain("{{")
  })

  it("keeps what the user typed in a nested Inputs when instruction mode is toggled", async () => {
    // The nested Inputs remounts when the block switches layouts; it must pick
    // up the registered values rather than re-registering its config defaults.
    mockEnabled = false
    mockExecution.rawScriptContent = "deploy --env {{ .inputs.Env }}"
    mockExecution.inputDependencies = ["Env"]
    mockExecution.inlineInputsId = "deploy-inputs"
    function RegisteredEnv() {
      const { blockInputs } = useRunbookContext()
      return (
        <div data-testid="registered-env">{String(blockInputs["deploy-inputs"]?.values.Env)}</div>
      )
    }
    const tree = () => (
      <TestWrapper>
        <Command id="test-cmd" command="deploy --env {{ .inputs.Env }}">
          <Inputs id="deploy-inputs" path="boilerplate.yml" />
        </Command>
        <RegisteredEnv />
      </TestWrapper>
    )
    const envField = () => screen.getByTestId("field-Env").querySelector("input")!

    const { rerender } = render(tree())
    fireEvent.change(envField(), { target: { value: "prod" } })
    await waitFor(() => expect(screen.getByTestId("registered-env")).toHaveTextContent("prod"))

    // Interactive → instruction: the form and the command keep 'prod'.
    mockEnabled = true
    rerender(tree())
    const block = screen.getByTestId("instruction-test-cmd")
    await waitFor(() => expect(within(block).getByText("deploy --env prod")).toBeInTheDocument())
    expect(envField()).toHaveValue("prod")
    expect(screen.getByTestId("registered-env")).toHaveTextContent("prod")

    // Instruction → interactive: still 'prod'.
    mockEnabled = false
    rerender(tree())
    await waitFor(() => expect(screen.queryByTestId("instruction-test-cmd")).toBeNull())
    expect(envField()).toHaveValue("prod")
    expect(screen.getByTestId("registered-env")).toHaveTextContent("prod")
  })

  it("sets the env with export lines before the command, quoted, in one block to copy", () => {
    mockExecution.rawScriptContent = 'aws s3 mb "s3://$BUCKET"'
    mockExecution.envTemplates = { BUCKET: "{{ .inputs.BucketName }}", NOTE: "it's $(not run)" }
    mockExecution.templateContext = { inputs: { BucketName: "my-bucket" }, outputs: {} }
    renderCommand({ command: 'aws s3 mb "s3://$BUCKET"' })

    const codes = screen.getByTestId("instruction-test-cmd").querySelectorAll("code")
    expect([...codes].map((code) => code.textContent)).toEqual([
      "export BUCKET='my-bucket'\nexport NOTE='it'\\''s $(not run)'\naws s3 mb \"s3://$BUCKET\"",
    ])
  })

  it("asks for an output the env references, and exports it once filled", async () => {
    mockExecution.rawScriptContent = 'gh pr edit --title "$PR_TITLE"'
    mockExecution.envTemplates = { PR_TITLE: "{{ .outputs.fetch_pr.TITLE }}" }
    renderCommand({ command: 'gh pr edit --title "$PR_TITLE"' })

    const block = screen.getByTestId("instruction-test-cmd")
    expect(block.querySelector("code")?.textContent).toContain("export PR_TITLE='<TITLE>'")

    fireEvent.change(screen.getByPlaceholderText(/paste the TITLE value/i), {
      target: { value: "Fix typo" },
    })
    await waitFor(() =>
      expect(block.querySelector("code")?.textContent).toContain("export PR_TITLE='Fix typo'"),
    )
  })

  it("sets a script's env in a block of its own, before the script", () => {
    mockExecution.rawScriptContent = 'aws s3 mb "s3://$BUCKET"'
    mockExecution.envTemplates = { BUCKET: "my-bucket" }
    renderCommand({ command: undefined, path: "scripts/make-bucket.sh" })

    const codes = screen.getByTestId("instruction-test-cmd").querySelectorAll("code")
    expect(codes[0]?.textContent).toBe("export BUCKET='my-bucket'")
  })

  it("counts as a step of the runbook, done once marked as done", () => {
    render(
      <TestWrapper>
        <Command id="test-cmd" command="echo hello" />
        <RunbookProgressProbe />
      </TestWrapper>,
    )
    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("0/1")

    fireEvent.click(screen.getByRole("button", { name: "Mark step as done" }))

    expect(screen.getByTestId("runbook-progress")).toHaveTextContent("1/1")
  })

  it("renders the interactive Run button when the flag is off", () => {
    mockEnabled = false
    renderCommand()
    expect(screen.getByRole("button", { name: /^run$/i })).toBeInTheDocument()
  })
})
