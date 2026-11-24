import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
import { RunbookProgressProbe, TestWrapper } from "@/test/test-utils"
import Command from "../Command"
import { Inputs } from "@/components/mdx/Inputs"
import { useRunbookContext } from "@/contexts/useRunbook"
import type { BoilerplateConfig } from "@/types/boilerplateConfig"

// Control the shared execution hook so we drive rawScriptContent + context.
const baseExecution = {
  rawScriptContent: "echo hello",
  language: "bash",
  fileError: null,
  envTemplates: {} as Record<string, string>,
  envVars: [] as Array<{ name: string; value: string }>,
  envError: null as string | null,
  workingDirTemplate: "",
  workingDirError: null as string | null,
  interpreter: "",
  interpreterError: null as string | null,
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
  unmetAzureAuthDependency: null as { blockId: string } | null,
  hasAzureAuthDependency: true,
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
// in the real hook), so values entered in the embedded form reach the env.
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

  it("shows the script as written, Go-template text for another tool included", () => {
    const script = "docker ps --format '{{.Names}}'"
    mockExecution.rawScriptContent = script
    mockExecution.templateContext = { inputs: { Names: "not this" }, outputs: {} }
    renderCommand({ command: script })

    const codes = screen.getByTestId("instruction-test-cmd").querySelectorAll("code")
    expect([...codes].map((code) => code.textContent)).toEqual([script])
  })

  it("resolves the env's input references from the form context", () => {
    mockExecution.rawScriptContent = 'echo "$NAME"'
    mockExecution.envTemplates = { NAME: "{{ .inputs.name }}" }
    mockExecution.templateContext = { inputs: { name: "world" }, outputs: {} }
    renderCommand({ command: 'echo "$NAME"' })

    const codes = screen.getByTestId("instruction-test-cmd").querySelectorAll("code")
    expect([...codes].map((code) => code.textContent)).toEqual([
      "export NAME='world'\necho \"$NAME\"",
    ])
  })

  it("auto-detects an output the env references as a manual field and resolves once filled", async () => {
    mockExecution.rawScriptContent = 'echo "$ACCOUNT_ID"'
    mockExecution.envTemplates = { ACCOUNT_ID: "{{ .outputs.create_account.account_id }}" }
    renderCommand({ command: 'echo "$ACCOUNT_ID"' })

    const block = screen.getByTestId("instruction-test-cmd")
    const field = screen.getByPlaceholderText(/paste the account_id value/i)
    expect(block.textContent).not.toContain("{{")

    fireEvent.change(field, { target: { value: "123456789012" } })
    await waitFor(() =>
      expect(block.querySelector("code")?.textContent).toContain(
        "export ACCOUNT_ID='123456789012'",
      ),
    )
  })

  it("renders a nested Inputs form and resolves the env from what the user enters", async () => {
    mockExecution.rawScriptContent = 'deploy --env "$ENV"'
    mockExecution.envTemplates = { ENV: "{{ .inputs.Env }}" }
    mockExecution.inputDependencies = ["Env"]
    mockExecution.inlineInputsId = "deploy-inputs"
    render(
      <TestWrapper>
        <Command id="test-cmd" command='deploy --env "$ENV"'>
          <Inputs id="deploy-inputs" path="boilerplate.yml" />
        </Command>
      </TestWrapper>,
    )

    const block = screen.getByTestId("instruction-test-cmd")
    const field = within(block).getByTestId("field-Env").querySelector("input")!
    const code = () => block.querySelector("code")?.textContent
    // Not filled in yet: the env shows a placeholder, not a raw template.
    await waitFor(() => expect(code()).toContain("export ENV='<Env>'"))

    fireEvent.change(field, { target: { value: "prod" } })
    await waitFor(() => expect(code()).toContain("export ENV='prod'"))
    expect(block.textContent).not.toContain("{{")
  })

  it("keeps what the user typed in a nested Inputs when instruction mode is toggled", async () => {
    // The nested Inputs remounts when the block switches layouts; it must pick
    // up the registered values rather than re-registering its config defaults.
    mockEnabled = false
    mockExecution.rawScriptContent = 'deploy --env "$ENV"'
    mockExecution.envTemplates = { ENV: "{{ .inputs.Env }}" }
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
        <Command id="test-cmd" command='deploy --env "$ENV"'>
          <Inputs id="deploy-inputs" path="boilerplate.yml" />
        </Command>
        <RegisteredEnv />
      </TestWrapper>
    )
    const envField = () => screen.getByTestId("field-Env").querySelector("input")!

    const { rerender } = render(tree())
    fireEvent.change(envField(), { target: { value: "prod" } })
    await waitFor(() => expect(screen.getByTestId("registered-env")).toHaveTextContent("prod"))

    // Interactive → instruction: the form and the env keep 'prod'.
    mockEnabled = true
    rerender(tree())
    const block = screen.getByTestId("instruction-test-cmd")
    await waitFor(() =>
      expect(block.querySelector("code")?.textContent).toContain("export ENV='prod'"),
    )
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

  it("changes to the block's working dir, resolved like the command, before the env and the command", () => {
    mockExecution.rawScriptContent = "tofu plan"
    mockExecution.envTemplates = { TF_IN_AUTOMATION: "1" }
    mockExecution.workingDirTemplate = "infra/{{ .inputs.Env }}/it's"
    mockExecution.templateContext = { inputs: { Env: "prod" }, outputs: {} }
    renderCommand({ command: "tofu plan" })

    const codes = screen.getByTestId("instruction-test-cmd").querySelectorAll("code")
    expect([...codes].map((code) => code.textContent)).toEqual([
      "cd 'infra/prod/it'\\''s'\nexport TF_IN_AUTOMATION='1'\ntofu plan",
    ])
  })

  it("changes to a script's working dir in a block of its own, before the script", () => {
    mockExecution.rawScriptContent = "tofu plan"
    mockExecution.workingDirTemplate = "infra/live"
    renderCommand({ command: undefined, path: "scripts/plan.sh" })

    const codes = screen.getByTestId("instruction-test-cmd").querySelectorAll("code")
    expect(codes[0]?.textContent).toBe("cd 'infra/live'")
  })

  it("points RUNBOOK_ENV at /dev/null for a script that writes to it, and says so", () => {
    const script = 'echo "REGION=us-east-1" >> "$RUNBOOK_ENV"'
    mockExecution.rawScriptContent = script
    mockExecution.workingDirTemplate = "infra"
    renderCommand({ command: script })

    const codes = screen.getByTestId("instruction-test-cmd").querySelectorAll("code")
    expect([...codes].map((code) => code.textContent)).toEqual([
      `export RUNBOOK_ENV=/dev/null\ncd 'infra'\n${script}`,
    ])
    expect(screen.getByTestId("instruction-test-cmd-runbook-env")).toHaveTextContent(
      "This step saves variables for later steps in $RUNBOOK_ENV. Your terminal discards them, so set the ones later steps need in your shell yourself.",
    )
  })

  it("names the program an interpreter prop runs the command with, and keeps the shell setup apart", () => {
    const script = 'print("hi")'
    mockExecution.rawScriptContent = script
    mockExecution.workingDirTemplate = "infra"
    mockExecution.interpreter = "python3"
    renderCommand({ command: script })

    const codes = screen.getByTestId("instruction-test-cmd").querySelectorAll("code")
    expect([...codes].map((code) => code.textContent)).toEqual(["cd 'infra'", script])
    expect(screen.getByTestId("instruction-test-cmd-interpreter")).toHaveTextContent(
      "Run this with python3:",
    )
  })

  it("says nothing about a program when the block has no interpreter prop", () => {
    mockExecution.rawScriptContent = "echo hello"
    renderCommand()

    expect(screen.queryByTestId("instruction-test-cmd-interpreter")).toBeNull()
  })

  it("adds no RUNBOOK_ENV line or note to a script that doesn't use it", () => {
    mockExecution.rawScriptContent = "echo hello"
    renderCommand()

    expect(screen.getByText("echo hello")).toBeInTheDocument()
    expect(screen.queryByTestId("instruction-test-cmd-runbook-env")).toBeNull()
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

  it("with autoCollapse, folds down to its title and checkbox once marked as done", () => {
    renderCommand({ title: "Install the tools", autoCollapse: true })
    expect(screen.getByText("echo hello")).toBeVisible()

    fireEvent.click(screen.getByRole("button", { name: "Mark step as done" }))
    expect(screen.getByText("Install the tools")).toBeVisible()
    expect(screen.getByText("echo hello")).not.toBeVisible()

    fireEvent.click(screen.getByRole("button", { name: "Mark step as not done" }))
    expect(screen.getByText("echo hello")).toBeVisible()
    expect(screen.queryByRole("button", { name: /^(Expand|Collapse) block$/ })).toBeNull()
  })

  it("renders the interactive Run button when the flag is off", () => {
    mockEnabled = false
    renderCommand()
    expect(screen.getByRole("button", { name: /^run$/i })).toBeInTheDocument()
  })
})
