import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { TestWrapper } from "@/test/test-utils"
import Command from "@/components/mdx/Command/Command"
import Check from "@/components/mdx/Check/Check"

// ---------------------------------------------------------------------------
// Mock useScriptExecution, keyed by block id, so each test sets every block's
// run status. The registry the blocks publish that status to, and the
// showWhenBlock condition that reads it, are real.
// ---------------------------------------------------------------------------

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    sourceCode: "true",
    rawScriptContent: "true",
    language: "bash",
    fileError: null,
    envTemplates: {},
    envVars: [],
    envError: null,
    inputDependencies: [] as string[],
    unmetInputDependencies: [],
    hasAllInputDependencies: true,
    inlineInputsId: null,
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
    unmetAzureAuthDependency: null,
    hasAzureAuthDependency: true,
    isRendering: false,
    renderError: null,
    status: "pending",
    logs: [],
    logFilePath: null,
    execError: null,
    execute: vi.fn(),
    cancel: vi.fn(),
    outputs: null,
    hasScriptDrift: false,
    ...overrides,
  }
}

let executions: Record<string, ReturnType<typeof makeExecution>> = {}

vi.mock("@/components/mdx/_shared/hooks/useScriptExecution", () => ({
  useScriptExecution: ({ componentId }: { componentId: string }) => executions[componentId],
}))

vi.mock("@/contexts/useLogs", () => ({
  useLogs: () => ({ registerLogs: vi.fn() }),
}))

function renderPlan(rerunProps: Record<string, unknown> = {}) {
  return render(
    <TestWrapper>
      <Check id="check-plan" command="true" />
      <Command
        id="rerun-plan"
        title="Re-run the plan"
        command="true"
        showWhenBlock={{ id: "check-plan", status: "fail" }}
        {...rerunProps}
      />
    </TestWrapper>,
  )
}

describe("showWhenBlock", () => {
  beforeEach(() => {
    executions = {}
  })

  it("hides the block before the block it names has run", () => {
    executions = { "check-plan": makeExecution(), "rerun-plan": makeExecution() }

    renderPlan()

    expect(screen.getByTestId("check-plan")).toBeInTheDocument()
    expect(screen.queryByTestId("rerun-plan")).not.toBeInTheDocument()
  })

  it("shows the block once the block it names has failed", async () => {
    executions = {
      "check-plan": makeExecution({ status: "fail" }),
      "rerun-plan": makeExecution(),
    }

    renderPlan()

    expect(await screen.findByTestId("rerun-plan")).toHaveTextContent("Re-run the plan")
  })

  it("hides the block again once the block it names succeeds", async () => {
    executions = {
      "check-plan": makeExecution({ status: "fail" }),
      "rerun-plan": makeExecution({ status: "success" }),
    }
    const { rerender } = renderPlan()
    await screen.findByTestId("rerun-plan")

    executions["check-plan"] = makeExecution({ status: "success" })
    rerender(
      <TestWrapper>
        <Check id="check-plan" command="true" />
        <Command
          id="rerun-plan"
          command="true"
          showWhenBlock={{ id: "check-plan", status: "fail" }}
        />
      </TestWrapper>,
    )

    await waitFor(() => expect(screen.queryByTestId("rerun-plan")).not.toBeInTheDocument())
  })

  it("keeps the block shown while it runs", async () => {
    executions = {
      "check-plan": makeExecution({ status: "running" }),
      "rerun-plan": makeExecution({ status: "running" }),
    }

    renderPlan()

    expect(await screen.findByTestId("rerun-plan")).toBeInTheDocument()
  })

  it("reports an id no block on the page has", async () => {
    executions = { "check-plan": makeExecution(), "rerun-plan": makeExecution() }

    renderPlan({ showWhenBlock: { id: "check-plna", status: "fail" } })

    expect(
      await screen.findByText(
        'showWhenBlock names "check-plna", but no Check, Command, Finish or Prerequisites block has that id.',
      ),
    ).toBeInTheDocument()
  })
})
