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
import { useState } from "react"
import { useAgentBlock, useAgentPresence } from "@/contexts/useAgentBridge"
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

/**
 * A stand-in for an Inputs block's form (the real one needs boilerplate over
 * IPC): one field whose default, an empty list, has consequences.
 */
function FakeForm() {
  const [regions, setRegions] = useState<unknown>([])
  useAgentPresence("config", "Inputs", undefined)
  useAgentBlock("config", {
    type: "Inputs",
    status: () => "pending",
    blockedBy: () => [],
    detail: () => ({
      inputs: [
        {
          name: "OptInRegions",
          type: "list",
          description: "Regions to opt in to. Empty means none.",
          value: regions,
          default: [],
        },
      ],
    }),
    setInputs: (values) => {
      if ("OptInRegions" in values) setRegions(values.OptInRegions)
      return { errors: {}, rejected: {} }
    },
    runIsAction: false,
    run: () => ({ started: true }),
  })
  return null
}

function renderPage(commandProps: Partial<React.ComponentProps<typeof Command>> = {}) {
  return render(
    <ApiProvider api={testApi.api}>
      <AgentBridgeProvider
        session={{ runbook: "demo", sessionName: "elegant-elephant", sessionId: "s1" }}
      >
        <TestWrapper>
          <FakeForm />
          <Command id="deploy-app" command="echo hi" title="Deploy" {...commandProps} />
        </TestWrapper>
      </AgentBridgeProvider>
    </ApiProvider>,
  )
}

/** Send `request` as main would, and resolve with the renderer's answer. */
let requestSeq = 0

async function ask(
  request: AgentRequest,
  timeout = 5000,
): Promise<{ ok: boolean; result?: any; error?: string }> {
  const before = testApi.callsTo("agent:respond").length
  const requestId = `r${++requestSeq}`
  act(() => testApi.emit("agent:request", { requestId, request }))
  // run_block answers once the window shows the run, or after a few seconds
  await waitFor(
    () =>
      expect(testApi.callsTo("agent:respond").some((r) => r.requestId === requestId)).toBe(true),
    { timeout },
  )
  void before
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
    expect(result.blocks.find((b: any) => b.id === "config")).toMatchObject({ needsReview: true })
    expect(result.blocks.filter((b: any) => b.id !== "config")).toEqual([
      {
        id: "deploy-app",
        type: "Command",
        title: "Deploy",
        status: "pending",
        blockedBy: [],
        controllable: true,
        actions: ["run"],
      },
    ])
  })

  it("runs a block through its own Run button's handler", async () => {
    renderPage()
    await waitFor(() => expect(testApi.callsTo("agent:status").length).toBe(1))
    const { result } = await ask({ op: "run_block", blockId: "deploy_app" })
    expect(result).toMatchObject({ started: true })
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

  it("says a run awaits approval, reports it, and respects a no", async () => {
    status = { enabled: true, confirmRuns: true }
    renderPage()
    await waitFor(() => expect(testApi.callsTo("agent:status").length).toBe(1))

    // Answered at once: the run waits for the user
    const first = await ask({ op: "run_block", blockId: "deploy-app" })
    expect(first.result).toMatchObject({ started: false, awaitingApproval: true })
    const waiting = await ask({ op: "get_block", blockId: "deploy-app" })
    expect(waiting.result).toMatchObject({
      status: "awaiting_approval",
      needsHuman: expect.stringContaining("Approve or decline"),
    })
    expect(mockExecution.execute).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByText("Don't run"))
    await waitFor(async () => {
      const after = await ask({ op: "get_block", blockId: "deploy-app" })
      expect(after.result).toMatchObject({
        status: "pending",
        note: expect.stringContaining("declined"),
      })
    })
    expect(mockExecution.execute).not.toHaveBeenCalled()

    // Approved: the run starts
    expect((await ask({ op: "run_block", blockId: "deploy-app" })).result).toMatchObject({
      awaitingApproval: true,
    })
    fireEvent.click(await screen.findByTestId("agent-confirm-run"))
    await waitFor(() => expect(mockExecution.execute).toHaveBeenCalledTimes(1))
  })

  it("reports a real status for a block without controls", async () => {
    function Shown() {
      useAgentPresence("note", "Admonition", undefined)
      return null
    }
    render(
      <ApiProvider api={testApi.api}>
        <AgentBridgeProvider session={{ runbook: "demo", sessionName: "s", sessionId: "s1" }}>
          <TestWrapper>
            <Shown />
          </TestWrapper>
        </AgentBridgeProvider>
      </ApiProvider>,
    )
    const { result } = await ask({ op: "get_session" })
    expect(result.blocks).toEqual([
      {
        id: "note",
        type: "Admonition",
        status: "pending",
        blockedBy: [],
        controllable: false,
        actions: [],
      },
    ])
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

  it("stops a block at the form it reads until the agent reviews the form, defaults included", async () => {
    renderPage({ inputsId: "config" })
    await waitFor(() => expect(testApi.callsTo("agent:status").length).toBe(1))
    const first = await ask({ op: "run_block", blockId: "deploy-app" })
    expect(first.result.started).toBe(false)
    expect(first.result.needsReview).toMatchObject({
      form: "config",
      unreviewed: ["OptInRegions"],
      fields: [{ name: "OptInRegions", default: [], reviewed: false }],
    })
    expect(first.result.reason).toContain("Defaults count as unreviewed")
    expect(mockExecution.execute).not.toHaveBeenCalled()

    const confirmed = await ask({ op: "confirm_inputs", blockId: "config" })
    expect(confirmed.result.fields[0].reviewed).toBe(true)
    expect((await ask({ op: "run_block", blockId: "deploy-app" })).result).toMatchObject({
      started: true,
    })
    expect(mockExecution.execute).toHaveBeenCalledTimes(1)
  })

  it("counts a value the agent sets as reviewed", async () => {
    renderPage({ inputsId: "config" })
    const set = await ask({
      op: "set_inputs",
      blockId: "config",
      values: { OptInRegions: ["us-east-1"] },
    })
    expect(set.result.unreviewed).toEqual([])
    const form = await ask({ op: "get_block", blockId: "config" })
    expect(form.result.inputs[0]).toMatchObject({ value: ["us-east-1"], reviewed: true })
  })

  it("starts a block once when two runs are asked for at once", async () => {
    renderPage()
    await waitFor(() => expect(testApi.callsTo("agent:status").length).toBe(1))
    act(() => {
      testApi.emit("agent:request", {
        requestId: "twice-1",
        request: { op: "run_block", blockId: "deploy-app" },
      })
      testApi.emit("agent:request", {
        requestId: "twice-2",
        request: { op: "run_block", blockId: "deploy-app" },
      })
    })
    await waitFor(
      () =>
        expect(
          testApi.callsTo("agent:respond").filter((r) => r.requestId.startsWith("twice")).length,
        ).toBe(2),
      { timeout: 10_000 },
    )
    const second = testApi.callsTo("agent:respond").find((r) => r.requestId === "twice-2")!
    expect(second).toMatchObject({
      result: { started: false, reason: "A run is already starting" },
    })
    expect(mockExecution.execute).toHaveBeenCalledTimes(1)
  }, 15_000)

  it("declines an open approval when access is turned off", async () => {
    status = { enabled: true, confirmRuns: true }
    renderPage()
    await waitFor(() => expect(testApi.callsTo("agent:status").length).toBe(1))
    act(() =>
      testApi.emit("agent:request", {
        requestId: "off-1",
        request: { op: "run_block", blockId: "deploy-app" },
      }),
    )
    await screen.findByTestId("agent-confirm-run")
    act(() => testApi.emit("agent:status-changed", { enabled: false, confirmRuns: true }))
    await waitFor(() =>
      expect(testApi.callsTo("agent:respond").find((r) => r.requestId === "off-1")).toMatchObject({
        result: { started: false },
      }),
    )
    expect(mockExecution.execute).not.toHaveBeenCalled()
  })

  it("pages logs with nextLogOffset and names the session", async () => {
    mockExecution = {
      ...mockExecution,
      status: "running",
      logs: ["a", "b", "c", "d"].map((line) => ({ line, timestamp: "" })),
    }
    renderPage()
    const { result } = await ask({
      op: "get_block",
      blockId: "deploy-app",
      logOffset: 1,
      logLimit: 2,
    })
    expect(result).toMatchObject({
      logs: ["b", "c"],
      nextLogOffset: 3,
      logTotal: 4,
      sessionId: "s1",
    })
  })
})
