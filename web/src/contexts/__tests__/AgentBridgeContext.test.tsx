/**
 * The renderer side of the app's MCP server: requests from main reach the
 * blocks on the page, and the answers go back over agent:respond. The
 * Command block is the real one, with its script execution mocked, so run_block
 * and cancel_block press its own Run and Stop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react"
import { ApiProvider } from "@/contexts/ApiContext"
import { AgentBridgeProvider } from "@/contexts/AgentBridgeContext"
import { TestWrapper } from "@/test/test-utils"
import { makeTestApi, type TestApi } from "@/test/test-api"
import Command from "@/components/mdx/Command/Command"
import { sensitiveOutput, type OutputValues } from "@/lib/outputValues"
import type { AgentRequest, AgentServerStatus } from "../../../../src/domain/agent/protocol"

const baseExecution = {
  sourceCode: "echo hi",
  rawScriptContent: "echo hi",
  language: "bash",
  fileError: null,
  envTemplates: {} as Record<string, string>,
  envVars: [] as Array<{ name: string; value: string }>,
  envError: null as string | null,
  inputValues: {},
  inputDependencies: [] as string[],
  unmetInputDependencies: [] as string[],
  hasAllInputDependencies: true,
  inlineInputsId: null,
  outputDependencies: [],
  outputDependencyBlockIds: [] as string[],
  unmetOutputDependencies: [] as Array<{ blockId: string; outputNames: string[] }>,
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
  logs: [] as Array<{ line: string; timestamp: string }>,
  execError: null,
  execute: vi.fn(),
  cancel: vi.fn(),
  outputs: null as OutputValues | null,
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

let testApi: TestApi
let status: AgentServerStatus

function renderPage() {
  return render(
    <ApiProvider api={testApi.api}>
      <AgentBridgeProvider
        session={{ runbook: "demo", sessionName: "elegant-elephant", sessionId: "s1" }}
      >
        <TestWrapper>
          <Command id="deploy-app" command="echo hi" title="Deploy" />
        </TestWrapper>
      </AgentBridgeProvider>
    </ApiProvider>,
  )
}

/** Send `request` as main would, and resolve with the renderer's answer. */
async function ask(request: AgentRequest): Promise<{ ok: boolean; result?: any; error?: string }> {
  const before = testApi.callsTo("agent:respond").length
  const requestId = `r${before}`
  act(() => testApi.emit("agent:request", { requestId, request }))
  // run_block answers once the window shows the run, or after a few seconds
  await waitFor(() => expect(testApi.callsTo("agent:respond").length).toBeGreaterThan(before), {
    timeout: 5000,
  })
  const response = testApi.callsTo("agent:respond").find((r) => r.requestId === requestId)!
  return response as never
}

beforeEach(() => {
  mockExecution = { ...baseExecution, execute: vi.fn(), cancel: vi.fn() }
  status = { enabled: true, confirmRuns: false }
  testApi = makeTestApi({
    "agent:status": () => status,
    "agent:respond": () => ({ ok: true }),
    "agent:update": (change) => ({ ...status, ...change }),
  })
})

describe("AgentBridgeProvider", () => {
  it("lists the blocks on the page with their state", async () => {
    renderPage()
    const { ok, result } = await ask({ op: "get_session" })
    expect(ok).toBe(true)
    expect(result).toMatchObject({ open: true, runbook: "demo", sessionName: "elegant-elephant" })
    expect(result.blocks).toEqual([
      {
        id: "deploy-app",
        type: "Command",
        title: "Deploy",
        status: "pending",
        blockedBy: [],
        controllable: true,
      },
    ])
  })

  it("runs a block through its own Run button's handler", async () => {
    renderPage()
    await waitFor(() => expect(testApi.callsTo("agent:status").length).toBe(1))
    const { result } = await ask({ op: "run_block", blockId: "deploy_app" })
    expect(result).toEqual({ started: true })
    expect(mockExecution.execute).toHaveBeenCalledTimes(1)
  })

  it("refuses to run a blocked block, saying why", async () => {
    mockExecution = {
      ...mockExecution,
      unmetAzureAuthDependency: { blockId: "azure" },
      hasAzureAuthDependency: false,
    }
    renderPage()
    const { result } = await ask({ op: "run_block", blockId: "deploy-app" })
    expect(result.started).toBe(false)
    expect(result.reason).toContain('Auth block "azure"')
    expect(mockExecution.execute).not.toHaveBeenCalled()
  })

  it("asks the user first when they want it to, and respects a no", async () => {
    status = { enabled: true, confirmRuns: true }
    renderPage()
    await waitFor(() => expect(testApi.callsTo("agent:status").length).toBe(1))
    const before = testApi.callsTo("agent:respond").length
    act(() =>
      testApi.emit("agent:request", {
        requestId: "confirm-1",
        request: { op: "run_block", blockId: "deploy-app" },
      }),
    )
    fireEvent.click(await screen.findByText("Don't run"))
    await waitFor(() => expect(testApi.callsTo("agent:respond").length).toBeGreaterThan(before))
    expect(testApi.callsTo("agent:respond").at(-1)).toMatchObject({
      requestId: "confirm-1",
      result: { started: false, reason: expect.stringContaining("declined") },
    })
    expect(mockExecution.execute).not.toHaveBeenCalled()

    act(() =>
      testApi.emit("agent:request", {
        requestId: "confirm-2",
        request: { op: "run_block", blockId: "deploy-app" },
      }),
    )
    fireEvent.click(await screen.findByTestId("agent-confirm-run"))
    await waitFor(() => expect(mockExecution.execute).toHaveBeenCalledTimes(1))
  })

  it("reads logs from an offset and masks sensitive outputs", async () => {
    mockExecution = {
      ...mockExecution,
      status: "success",
      logs: ["a", "b", "c"].map((line) => ({ line, timestamp: "" })),
      outputs: { region: "eastus", token: sensitiveOutput("s3cret") },
    }
    renderPage()
    const { result } = await ask({
      op: "get_block",
      blockId: "deploy-app",
      logOffset: 1,
      logLimit: 5,
    })
    expect(result).toMatchObject({
      status: "success",
      logs: ["b", "c"],
      logOffset: 1,
      logTotal: 3,
      outputs: { region: "eastus", token: "<redacted>" },
    })
  })

  it("stops a running block", async () => {
    mockExecution = { ...mockExecution, status: "running" }
    renderPage()
    const { result } = await ask({ op: "cancel_block", blockId: "deploy-app" })
    expect(result).toEqual({ cancelled: true })
    expect(mockExecution.cancel).toHaveBeenCalled()
  })

  it("answers an error for a block that isn't on the page", async () => {
    renderPage()
    const response = await ask({ op: "get_block", blockId: "nope" })
    expect(response.ok).toBe(false)
    expect(response.error).toContain('No block "nope"')
  })

  it("shows that an agent is connected, with a way to turn access off", async () => {
    renderPage()
    expect(screen.queryByTestId("agent-indicator")).toBeNull()
    await waitFor(() => expect(testApi.callsTo("agent:status").length).toBe(1))
    act(() => testApi.emit("agent:activity"))
    const indicator = await screen.findByTestId("agent-indicator")
    expect(indicator.textContent).toContain("AI agent connected")
    fireEvent.click(screen.getByTitle("Turn off AI agent access"))
    await waitFor(() => expect(testApi.callsTo("agent:update")).toEqual([{ enabled: false }]))
  })
})
