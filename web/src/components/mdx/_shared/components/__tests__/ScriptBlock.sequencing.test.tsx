import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TestWrapper } from "@/test/test-utils"
import Command from "@/components/mdx/Command/Command"
import Check from "@/components/mdx/Check/Check"

// ---------------------------------------------------------------------------
// Mock useScriptExecution, keyed by block id, so each test sets every block's
// run status. The registry the blocks publish that status to, and the gating
// that reads it, are real.
// ---------------------------------------------------------------------------

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    sourceCode: "true",
    rawScriptContent: "true",
    language: "bash",
    fileError: null,
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

function runButton(blockId: string, name = "Run") {
  return within(screen.getByTestId(blockId)).getByRole("button", { name })
}

function warning(blockId: string) {
  return within(screen.getByTestId(blockId)).queryByTestId("run-blocked-warning")
}

describe("Command and Check run sequencing", () => {
  beforeEach(() => {
    executions = {}
    Element.prototype.scrollIntoView = vi.fn()
  })

  it("lets a block run while an unrelated block is running", () => {
    executions = {
      lint: makeExecution({ status: "running" }),
      deploy: makeExecution(),
    }

    render(
      <TestWrapper>
        <Command id="lint" command="true" />
        <Command id="deploy" command="true" />
      </TestWrapper>,
    )

    expect(runButton("deploy")).toBeEnabled()
    expect(warning("deploy")).toBeNull()
  })

  it("holds a block back while the block whose outputs it uses is running", () => {
    executions = {
      "build-image": makeExecution({ status: "running" }),
      deploy: makeExecution({ outputDependencyBlockIds: ["build_image"] }),
    }

    render(
      <TestWrapper>
        <Command id="build-image" command="true" />
        <Command id="deploy" command="echo {{ .outputs.build_image.tag }}" />
      </TestWrapper>,
    )

    expect(runButton("deploy")).toBeDisabled()
    expect(warning("deploy")).toHaveTextContent("Waiting for a running block: build-image")
  })

  it("stops the running block from the block that waits for it", async () => {
    const user = userEvent.setup()
    executions = {
      "build-image": makeExecution({ status: "running" }),
      deploy: makeExecution({ outputDependencyBlockIds: ["build_image"] }),
    }

    render(
      <TestWrapper>
        <Command id="build-image" command="true" />
        <Command id="deploy" command="true" />
      </TestWrapper>,
    )
    await user.click(within(warning("deploy")!).getByRole("button", { name: "Stop build-image" }))

    expect(executions["build-image"]!.cancel).toHaveBeenCalledTimes(1)
    expect(executions.deploy!.cancel).not.toHaveBeenCalled()
  })

  it("scrolls to the running block from the block that waits for it", async () => {
    const user = userEvent.setup()
    executions = {
      "build-image": makeExecution({ status: "running" }),
      deploy: makeExecution({ outputDependencyBlockIds: ["build_image"] }),
    }

    render(
      <TestWrapper>
        <Command id="build-image" command="true" />
        <Command id="deploy" command="true" />
      </TestWrapper>,
    )
    await user.click(within(warning("deploy")!).getByRole("button", { name: "build-image" }))

    const scrolled = vi.mocked(Element.prototype.scrollIntoView).mock.instances
    expect(scrolled).toEqual([screen.getByTestId("build-image")])
  })

  it("holds a dependsOn block back until the block it names has succeeded", () => {
    executions = { login: makeExecution(), deploy: makeExecution() }
    const tree = () => (
      <TestWrapper>
        <Command id="login" command="true" />
        <Command id="deploy" command="true" dependsOn="login" />
      </TestWrapper>
    )

    const { rerender } = render(tree())
    expect(runButton("deploy")).toBeDisabled()
    expect(warning("deploy")).toHaveTextContent("Waiting for: login")

    executions.login = makeExecution({ status: "running" })
    rerender(tree())
    expect(runButton("deploy")).toBeDisabled()
    expect(warning("deploy")).toHaveTextContent("Waiting for a running block: login")

    executions.login = makeExecution({ status: "success" })
    rerender(tree())
    expect(runButton("deploy")).toBeEnabled()
    expect(warning("deploy")).toBeNull()
  })

  it("holds a dependsOn block back again when the block it names fails a later run", () => {
    executions = { login: makeExecution({ status: "success" }), deploy: makeExecution() }
    const tree = () => (
      <TestWrapper>
        <Command id="login" command="true" />
        <Command id="deploy" command="true" dependsOn={["login"]} />
      </TestWrapper>
    )

    const { rerender } = render(tree())
    expect(runButton("deploy")).toBeEnabled()

    executions.login = makeExecution({ status: "fail" })
    rerender(tree())
    expect(runButton("deploy")).toBeDisabled()
  })

  it("accepts a Check that passed with a warning as a dependsOn block", () => {
    executions = { preflight: makeExecution({ status: "warn" }), deploy: makeExecution() }

    render(
      <TestWrapper>
        <Check id="preflight" command="true" />
        <Command id="deploy" command="true" dependsOn="preflight" />
      </TestWrapper>,
    )

    expect(runButton("deploy")).toBeEnabled()
  })

  it("holds every other block back while an exclusive block runs", () => {
    executions = {
      migrate: makeExecution({ status: "running" }),
      lint: makeExecution(),
    }

    render(
      <TestWrapper>
        <Command id="migrate" command="true" exclusive />
        <Check id="lint" command="true" />
      </TestWrapper>,
    )

    expect(runButton("lint", "Check")).toBeDisabled()
    expect(warning("lint")).toHaveTextContent(
      "Waiting for a running block: migrate It can't run alongside other blocks.",
    )
  })

  it("holds an exclusive block back while any other block runs", () => {
    executions = {
      lint: makeExecution({ status: "running" }),
      migrate: makeExecution(),
    }

    render(
      <TestWrapper>
        <Check id="lint" command="true" />
        <Command id="migrate" command="true" exclusive />
      </TestWrapper>,
    )

    expect(runButton("migrate")).toBeDisabled()
    expect(warning("migrate")).toHaveTextContent(
      "Waiting for a running block: lint This command can't run alongside other blocks.",
    )
  })

  it("frees the waiting block when the running block is removed", () => {
    executions = {
      migrate: makeExecution({ status: "running" }),
      lint: makeExecution(),
    }

    const { rerender } = render(
      <TestWrapper>
        <Command id="migrate" command="true" exclusive />
        <Command id="lint" command="true" />
      </TestWrapper>,
    )
    expect(runButton("lint")).toBeDisabled()

    rerender(
      <TestWrapper>
        <Command id="lint" command="true" />
      </TestWrapper>,
    )
    expect(runButton("lint")).toBeEnabled()
  })
})
