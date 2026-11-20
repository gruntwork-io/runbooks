/**
 * Requests from the MCP server to the renderer, which holds the runbook's
 * live state: each one goes out as an `agent:request` event and comes back
 * through the `agent:respond` handler, matched by its request id.
 *
 * No electron import, so Bun can test it: ipc/agent.ts passes `send`.
 */
import type {
  AgentRequest,
  AgentRequestEvent,
  AgentResponse,
  AgentResponseMap,
} from "../../../src/domain/agent/protocol.ts"
import { errorMessage } from "../../../src/errors/message.ts"

/** How long the renderer has to answer one request. Runs don't wait: run_block answers once the run starts. */
const DEFAULT_TIMEOUT_MS = 20_000

export interface AgentBridge {
  /** Ask the renderer; `timeoutMs` overrides how long it has to answer. */
  request<R extends AgentRequest>(
    request: R,
    timeoutMs?: number,
  ): Promise<AgentResponseMap[R["op"]]>
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class RendererBridge implements AgentBridge {
  private pending = new Map<string, Pending>()
  private seq = 0

  /**
   * `send` delivers the event to the app's window and returns false when
   * there is no window to deliver it to.
   */
  constructor(
    private send: (event: AgentRequestEvent) => boolean,
    private timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  request<R extends AgentRequest>(
    request: R,
    timeoutMs = this.timeoutMs,
  ): Promise<AgentResponseMap[R["op"]]> {
    const requestId = `agent-${++this.seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(
          new Error(
            "The Runbooks window didn't answer. Is a runbook open and the window responsive?",
          ),
        )
      }, timeoutMs)
      this.pending.set(requestId, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      })
      const fail = (error: Error) => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error)
      }
      try {
        if (!this.send({ requestId, request })) fail(new Error("The Runbooks window isn't open."))
      } catch (err: unknown) {
        fail(new Error(`Couldn't reach the Runbooks window: ${errorMessage(err)}`))
      }
    })
  }

  /** Settle the request the renderer answered. An unknown or late id is ignored. */
  respond(response: AgentResponse): void {
    const pending = this.pending.get(response.requestId)
    if (!pending) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.ok) pending.resolve(response.result)
    else pending.reject(new Error(response.error))
  }

  /** Fail every request still waiting, e.g. when the server stops. */
  rejectAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
      this.pending.delete(id)
    }
  }
}
