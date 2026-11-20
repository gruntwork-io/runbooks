import type { ReactNode } from "react"
import { act, render, waitFor } from "@testing-library/react"
import { expect } from "vitest"
import { ApiProvider } from "@/contexts/ApiContext"
import { AgentBridgeProvider } from "@/contexts/AgentBridgeContext"
import { TestWrapper } from "@/test/test-utils"
import { makeTestApi, type Handlers, type TestApi } from "@/test/test-api"
import { AGENT_BLOCK_STATUSES, type AgentRequest } from "../../../src/domain/agent/protocol"

/**
 * Test harness for blocks' agent adapters: renders blocks under the agent
 * bridge, with agent access on and no approvals asked, and sends them
 * requests as the app's MCP server would.
 */
export function renderWithAgent(ui: ReactNode, handlers: Handlers = {}): TestApi {
  const testApi = makeTestApi({
    "agent:status": () => ({ enabled: true, confirmRuns: false }),
    "agent:respond": () => ({ ok: true as const }),
    ...handlers,
  })
  render(
    <ApiProvider api={testApi.api}>
      <AgentBridgeProvider session={{ runbook: "demo", sessionName: "test", sessionId: "s1" }}>
        <TestWrapper>{ui}</TestWrapper>
      </AgentBridgeProvider>
    </ApiProvider>,
  )
  return testApi
}

let seq = 0

/** Send `request` to the bridge and resolve with its answer, failing on an error answer. */
export async function askAgent(
  testApi: TestApi,
  request: AgentRequest,
  timeout = 5000,
): Promise<any> {
  // The provider reads agent:status once on mount; a run waits for it
  await waitFor(() => expect(testApi.callsTo("agent:status").length).toBeGreaterThan(0))
  const requestId = `t${++seq}`
  act(() => testApi.emit("agent:request", { requestId, request }))
  let response: { ok: boolean; result?: unknown; error?: string } | undefined
  await waitFor(
    () => {
      response = testApi.callsTo("agent:respond").find((r) => r.requestId === requestId)
      expect(response).toBeDefined()
    },
    { timeout },
  )
  if (!response!.ok) throw new Error(response!.error)
  // Every block reports one of the real statuses, whether or not an agent can act on it
  const result = response!.result as { status?: string; blocks?: Array<{ status: string }> }
  for (const status of [result.status, ...(result.blocks ?? []).map((b) => b.status)]) {
    if (status !== undefined && (request.op === "get_block" || request.op === "get_session")) {
      expect(AGENT_BLOCK_STATUSES).toContain(status)
    }
  }
  return response!.result
}

/** The names of the actions get_block says are available now. */
export function availableActions(detail: {
  actionSpecs?: Array<{ name: string; unavailable?: string }>
}) {
  return (detail.actionSpecs ?? []).filter((a) => !a.unavailable).map((a) => a.name)
}
