/**
 * The app's MCP endpoint: what it refuses, and that each tool reaches the
 * renderer as the right request. A fake bridge stands in for the window.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import * as net from "node:net"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { AgentRequest, AgentBlockDetail } from "../../../src/domain/agent/protocol.ts"
import type { AgentBridge } from "./bridge.ts"
import { startAgentServer, type RunningAgentServer } from "./server.ts"
import { createAgentMcpServer } from "./tools.ts"

const TOKEN = "test-token-0123456789"

/** Records each request and answers from `answers`. */
function fakeBridge(answer: (request: AgentRequest) => unknown) {
  const requests: AgentRequest[] = []
  const bridge: AgentBridge = {
    request: (request) => {
      requests.push(request)
      return Promise.resolve(answer(request)) as never
    },
  }
  return { bridge, requests }
}

let server: RunningAgentServer
let requests: AgentRequest[]
let blockStatus: AgentBlockDetail["status"]
let activity = 0

beforeEach(async () => {
  blockStatus = "pending"
  activity = 0
  const fake = fakeBridge((request) => {
    switch (request.op) {
      case "get_session":
        return {
          open: true,
          runbook: "demo",
          sessionName: "elegant-elephant",
          sessionId: "s1",
          blocks: [
            {
              id: "deploy",
              type: "Command",
              status: blockStatus,
              blockedBy: [],
              controllable: true,
            },
          ],
        }
      case "get_block":
        return {
          id: request.blockId,
          type: "Command",
          status: blockStatus,
          blockedBy: [],
          controllable: true,
          logs: ["line"].slice(0, request.logLimit),
          logTotal: 1,
        }
      case "run_block":
        blockStatus = "running"
        setTimeout(() => {
          blockStatus = "success"
        }, 700)
        return { started: true }
      case "set_inputs":
        return { errors: {}, rejected: {} }
      case "cancel_block":
        return { cancelled: true }
      case "get_outputs":
        return {}
      case "confirm_inputs":
        return { confirmed: request.blockId, fields: [] }
      case "act_on_block":
        return { ok: true }
    }
  })
  requests = fake.requests
  server = await startAgentServer({
    port: 0,
    token: TOKEN,
    createServer: () => createAgentMcpServer(fake.bridge, "test"),
    onAuthorizedRequest: () => activity++,
  })
})

afterEach(async () => {
  await server.close()
})

function post(headers: Record<string, string>, url = server.url) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  })
}

describe("requests it refuses", () => {
  it("without a token, or with the wrong one", async () => {
    const none = await post({})
    expect(none.status).toBe(401)
    expect(none.headers.get("www-authenticate")).toBe("Bearer")
    expect((await post({ authorization: "Bearer nope" })).status).toBe(401)
    expect(activity).toBe(0)
  })

  it("from a browser page (an Origin header)", async () => {
    const res = await post({ authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" })
    expect(res.status).toBe(403)
  })

  it("with a request target that isn't a valid URL, without crashing", async () => {
    const port = new URL(server.url).port
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(port), "127.0.0.1", () => {
        socket.write(
          `POST //[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
        )
      })
      let data = ""
      socket.on("data", (chunk) => (data += chunk.toString()))
      socket.on("end", () => resolve(data))
      socket.on("error", reject)
    })
    expect(reply).toStartWith("HTTP/1.1 400")
    // Still serving
    expect((await post({})).status).toBe(401)
  })

  it("on another path", async () => {
    const res = await post(
      { authorization: `Bearer ${TOKEN}` },
      server.url.replace("/mcp", "/other"),
    )
    expect(res.status).toBe(404)
  })

  it("listens on the loopback address only", () => {
    expect(server.url).toStartWith("http://127.0.0.1:")
  })
})

describe("tools", () => {
  let client: Client

  beforeEach(async () => {
    client = new Client({ name: "test", version: "0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    )
  })

  afterEach(async () => {
    await client.close()
  })

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError).toBeFalsy()
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
  }

  it("lists the tools, marking run_block destructive", async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      "act_on_block",
      "cancel_block",
      "confirm_inputs",
      "get_block",
      "get_outputs",
      "get_session",
      "list_sessions",
      "run_block",
      "set_inputs",
      "wait_for_block",
    ])
    const run = tools.find((t) => t.name === "run_block")!
    expect(run.annotations?.destructiveHint).toBe(true)
    expect(run.description).toContain("real cloud resources")
    expect(activity).toBeGreaterThan(0)
  })

  it("routes each tool to the window", async () => {
    expect(await call("list_sessions")).toEqual([
      { session_id: "s1", session_name: "elegant-elephant", runbook: "demo", blocks: 1 },
    ])
    await call("set_inputs", { block_id: "config", values: { Region: "eastus" } })
    await call("cancel_block", { block_id: "deploy" })
    await call("confirm_inputs", { block_id: "config" })
    await call("act_on_block", { block_id: "repo", action: "clone", params: { url: "u" } })
    await call("get_outputs")
    expect(requests).toContainEqual({ op: "get_session" })
    expect(requests).toContainEqual({
      op: "set_inputs",
      blockId: "config",
      values: { Region: "eastus" },
    })
    expect(requests).toContainEqual({ op: "cancel_block", blockId: "deploy" })
    expect(requests).toContainEqual({ op: "get_outputs" })
    expect(requests).toContainEqual({ op: "confirm_inputs", blockId: "config" })
    expect(requests).toContainEqual({
      op: "act_on_block",
      blockId: "repo",
      action: "clone",
      params: { url: "u" },
    })
  })

  it("starts a run, then waits for it to end", async () => {
    expect(await call("run_block", { block_id: "deploy" })).toEqual({ started: true })
    const waited = await call("wait_for_block", { block_id: "deploy", timeout_seconds: 10 })
    expect(waited.status).toBe("success")
    expect(waited.timed_out).toBe(false)
    expect(waited.logs).toEqual(["line"])
  })

  it("says when the wait timed out", async () => {
    blockStatus = "running"
    const waited = await call("wait_for_block", { block_id: "deploy", timeout_seconds: 1 })
    expect(waited.timed_out).toBe(true)
  })
})

describe("wait_for_block against a window that misbehaves", () => {
  /** A server over `answer`, and a connected client. */
  async function serve(answer: (request: AgentRequest) => Promise<unknown>) {
    // Gives up after timeoutMs, as RendererBridge does
    const bridge: AgentBridge = {
      request: (request, timeoutMs = 20_000) =>
        Promise.race([
          answer(request),
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("The Runbooks window didn't answer.")), timeoutMs)
          }),
        ]) as never,
    }
    const own = await startAgentServer({
      port: 0,
      token: TOKEN,
      createServer: () => createAgentMcpServer(bridge, "test"),
    })
    const c = new Client({ name: "test", version: "0" })
    await c.connect(
      new StreamableHTTPClientTransport(new URL(own.url), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    )
    return { own, c }
  }
  const running = (sessionId: string) => ({
    id: "deploy",
    type: "Command",
    status: "running",
    blockedBy: [],
    controllable: true,
    sessionId,
  })

  it("keeps to its deadline when the window stops answering", async () => {
    let reads = 0
    const { own, c } = await serve(() => {
      reads++
      // The first read answers; every later one hangs, as a frozen window would
      return reads === 1 ? Promise.resolve(running("s1")) : new Promise(() => {})
    })
    try {
      const started = Date.now()
      const result = await c.callTool({
        name: "wait_for_block",
        arguments: { block_id: "deploy", timeout_seconds: 2 },
      })
      const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text)
      expect(body).toMatchObject({ status: "running", timed_out: true })
      expect(Date.now() - started).toBeLessThan(6000)
    } finally {
      await c.close()
      await own.close()
    }
  })

  it("fails when the window switches to another session", async () => {
    let reads = 0
    const { own, c } = await serve(() => Promise.resolve(running(++reads === 1 ? "s1" : "s2")))
    try {
      const result = await c.callTool({
        name: "wait_for_block",
        arguments: { block_id: "deploy", timeout_seconds: 5 },
      })
      expect(result.isError).toBe(true)
      expect((result.content as Array<{ text: string }>)[0]!.text).toContain("another session")
    } finally {
      await c.close()
      await own.close()
    }
  })
})
