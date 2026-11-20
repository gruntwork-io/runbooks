/**
 * The app's MCP tools. They act on the runbook open in the window, through
 * the renderer (see bridge.ts): what an agent does shows in the window, as if
 * the user had done it, and the user can watch, stop a run or take over.
 *
 * No electron import, so Bun can test it with a fake bridge.
 */
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"
import type { AgentBridge } from "./bridge.ts"
import type { AgentBlockDetail } from "../../../src/domain/agent/protocol.ts"
import { errorMessage } from "../../../src/errors/message.ts"

const INSTRUCTIONS = `Drives the runbook open in the Gruntwork Runbooks desktop app, in the user's live session. Everything you do shows in their window.
Workflow: get_session -> get_block for inputs and blocked_by -> set_inputs, then run_block on the Inputs block to submit it -> run_block -> wait_for_block (repeat until it ends) -> get_outputs.
run_block runs real scripts on the user's machine with their credentials; they can create, change or destroy cloud resources. Confirm with the user before running blocks that change infrastructure. The app may also ask the user to approve each run.
Blocks that need the user (sign-in, pull requests, directory pickers) are marked controllable: false; ask the user to do them in the window.`

const RUNS_SCRIPTS =
  "WARNING: this runs the block for real, exactly as if the user clicked Run in the window: its script runs on the user's machine with their environment and credentials and can create, change or destroy real cloud resources."

/** Longest wait_for_block waits in one call, to stay well inside MCP clients' tool timeouts. */
export const MAX_WAIT_SECONDS = 120
const POLL_MS = 500
const DEFAULT_LOG_LIMIT = 200

const blockId = z.string().describe("The block's id, as get_session lists it")
const logOffset = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("First log line to return; pass the previous call's log_total to get only new lines")
const logLimit = z
  .number()
  .int()
  .min(0)
  .max(5000)
  .optional()
  .describe(`Most log lines to return (default ${DEFAULT_LOG_LIMIT})`)

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

async function run(fn: () => unknown): Promise<CallToolResult> {
  try {
    return json(await fn())
  } catch (e: unknown) {
    return { content: [{ type: "text", text: errorMessage(e) }], isError: true }
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/** Create the server for one HTTP request. `bridge` reaches the window. */
export function createAgentMcpServer(bridge: AgentBridge, version: string): McpServer {
  const server = new McpServer(
    { name: "runbooks-app", version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  )

  const getBlock = (id: string, offset?: number, limit?: number) =>
    bridge.request({
      op: "get_block",
      blockId: id,
      ...(offset !== undefined ? { logOffset: offset } : {}),
      logLimit: limit ?? DEFAULT_LOG_LIMIT,
    })

  server.registerTool(
    "list_sessions",
    {
      title: "List open sessions",
      description:
        "The runbook sessions open in the Runbooks app: runbook, session name and how many blocks. The app shows one runbook at a time.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const s = await bridge.request({ op: "get_session" })
        return s.open
          ? [
              {
                session_id: s.sessionId,
                session_name: s.sessionName,
                runbook: s.runbook,
                runbook_path: s.runbookPath,
                blocks: s.blocks.length,
              },
            ]
          : []
      }),
  )

  server.registerTool(
    "get_session",
    {
      title: "Show the open session",
      description:
        "The runbook open in the app and every block on the page, in order: id, type, title, status as the window shows it, blocked_by (why its Run button is disabled) and whether an agent can control it.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () => run(() => bridge.request({ op: "get_session" })),
  )

  server.registerTool(
    "get_block",
    {
      title: "Show a block",
      description:
        "One block: status, blocked_by, its latest run's log lines (from log_offset; log_total says how many there are), error, exit code and outputs, and for an Inputs or Template block its fields with their values and errors.",
      inputSchema: z.object({ block_id: blockId, log_offset: logOffset, log_limit: logLimit }),
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => getBlock(args.block_id, args.log_offset, args.log_limit)),
  )

  server.registerTool(
    "set_inputs",
    {
      title: "Fill in a form",
      description:
        'Enter values in an Inputs or Template block\'s form, as if the user typed them, keyed by variable name (e.g. {"Region": "eastus"}). Read-only fields are left alone. Returns the form\'s errors. Runs nothing. An Inputs block\'s values reach other blocks once it is submitted: call run_block on it, as its Submit button does.',
      inputSchema: z.object({
        block_id: blockId,
        values: z.record(z.string(), z.unknown()).describe("Values by variable name"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) =>
      run(() => bridge.request({ op: "set_inputs", blockId: args.block_id, values: args.values })),
  )

  server.registerTool(
    "run_block",
    {
      title: "Run a block",
      description: `Start a Command, Check or Finish block, generate a Template or submit an Inputs form, through the same code path as its button in the window, and return once it has started. Follow with wait_for_block or get_block. Refused, with the reason, while the block is blocked, or when the user declines in the window. ${RUNS_SCRIPTS}`,
      inputSchema: z.object({ block_id: blockId }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) => run(() => bridge.request({ op: "run_block", blockId: args.block_id })),
  )

  server.registerTool(
    "wait_for_block",
    {
      title: "Wait for a block",
      description: `Wait until a block's run ends, or timeout_seconds pass (at most ${MAX_WAIT_SECONDS}), then return it as get_block does, with timed_out. Long runs: call it again until timed_out is false, passing log_offset to get only new log lines.`,
      inputSchema: z.object({
        block_id: blockId,
        timeout_seconds: z.number().int().min(1).max(MAX_WAIT_SECONDS).optional(),
        log_offset: logOffset,
        log_limit: logLimit,
      }),
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(async () => {
        const deadline = Date.now() + (args.timeout_seconds ?? 30) * 1000
        let detail: AgentBlockDetail = await getBlock(args.block_id, args.log_offset, 0)
        while (detail.status === "running" && Date.now() < deadline) {
          await sleep(POLL_MS)
          detail = await getBlock(args.block_id, args.log_offset, 0)
        }
        const final = await getBlock(args.block_id, args.log_offset, args.log_limit)
        return { ...final, timed_out: final.status === "running" }
      }),
  )

  server.registerTool(
    "cancel_block",
    {
      title: "Stop a block",
      description: "Stop a running block, as its Stop button does.",
      inputSchema: z.object({ block_id: blockId }),
      annotations: { destructiveHint: false },
    },
    (args) => run(() => bridge.request({ op: "cancel_block", blockId: args.block_id })),
  )

  server.registerTool(
    "get_outputs",
    {
      title: "Show block outputs",
      description:
        "Every block's outputs so far, by block id. Sensitive outputs show as <redacted>.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () => run(() => bridge.request({ op: "get_outputs" })),
  )

  return server
}
