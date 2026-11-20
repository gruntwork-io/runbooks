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
import {
  AGENT_APPROVAL_TIMEOUT_MS,
  type AgentBlockDetail,
} from "../../../src/domain/agent/protocol.ts"
import { errorMessage } from "../../../src/errors/message.ts"

const INSTRUCTIONS = `Drives the runbook open in the Gruntwork Runbooks desktop app, in the user's live session. Everything you do shows in their window.
Workflow: get_session -> run_block, which stops at each Inputs or Template form you haven't reviewed (needsReview) -> read that form's fields, descriptions and defaults, then set_inputs or confirm_inputs, and run_block on the Inputs block to submit it -> run_block -> wait_for_block (repeat until it ends) -> get_outputs.
Review each form in the context of the block that uses it: defaults are not reviewed values, and some (an empty list of regions, say) have consequences the field's description explains. Ask the user when a value isn't clear.
run_block runs real scripts on the user's machine with their credentials; they can create, change or destroy cloud resources. Confirm with the user before running blocks that change infrastructure. The app may also ask the user to approve each run.
Every block on the page can be driven: run_block presses its main button, and act_on_block uses its other controls (get_block lists them). When a step truly needs the person at the window (a browser sign-in, MFA), the block reports needsHuman with what they must do: tell the user, then wait_for_block or get_block.`

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
  .describe("First log line to return; pass the previous call's nextLogOffset to continue")
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

  const getBlock = (id: string, offset?: number, limit?: number, timeoutMs?: number) =>
    bridge.request(
      {
        op: "get_block",
        blockId: id,
        ...(offset !== undefined ? { logOffset: offset } : {}),
        logLimit: limit ?? DEFAULT_LOG_LIMIT,
      },
      timeoutMs,
    )

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
        "One block: status, blocked_by, its latest run's log lines (from log_offset; nextLogOffset is where the next page starts and logTotal how many there are), error, exit code and outputs, and for an Inputs or Template block its fields with their values and errors.",
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
        'Enter values in an Inputs or Template block\'s form, as if the user typed them, keyed by variable name (e.g. {"Region": "eastus"}). Read-only fields are left alone. Each value entered counts as reviewed. Returns the form\'s errors and the fields still unreviewed. Runs nothing. An Inputs block\'s values reach other blocks once it is submitted: call run_block on it, as its Submit button does.',
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
    "confirm_inputs",
    {
      title: "Confirm a form",
      description:
        "Accept an Inputs or Template form's values as the window shows them, defaults included, as a person does by reading the form and moving on. Only after reading each field's description: run_block refuses a block that reads a form until its fields are set or confirmed. Runs nothing.",
      inputSchema: z.object({ block_id: blockId }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    (args) => run(() => bridge.request({ op: "confirm_inputs", blockId: args.block_id })),
  )

  server.registerTool(
    "run_block",
    {
      title: "Run a block",
      description: `Start a Command, Check or Finish block, generate a Template or submit an Inputs form, through the same code path as its button in the window, and return once it has started. Follow with wait_for_block or get_block. Refused, with the reason, while the block is blocked, when the user declines in the window, or while a form the block reads (itself, for a form) has fields you haven't set or confirmed: then needsReview holds that form's fields, defaults and validations. ${RUNS_SCRIPTS}`,
      inputSchema: z.object({ block_id: blockId }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      run(() =>
        // Long enough for the user to answer the approval the window may show;
        // the window declines it before this runs out
        bridge.request(
          { op: "run_block", blockId: args.block_id },
          AGENT_APPROVAL_TIMEOUT_MS + 30_000,
        ),
      ),
  )

  server.registerTool(
    "act_on_block",
    {
      title: "Act on a block",
      description: `Use one of a block's controls other than its Run button: accept a detected credential, start a sign-in, pick a tenant, subscription, profile or project, clone a repository or use a local checkout, fill in and create a pull request, pick a directory, and so on. get_block lists each block's actions with their params; actions marked changes: true can change real things and may need the user's approval in the window, like run_block. When an action needs the person at the window (a browser sign-in, MFA), the block's needsHuman says what they must do. ${RUNS_SCRIPTS}`,
      inputSchema: z.object({
        block_id: blockId,
        action: z.string().describe("An action name from get_block's actions"),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("The action's params, as get_block describes them"),
      }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      run(() =>
        bridge.request(
          {
            op: "act_on_block",
            blockId: args.block_id,
            action: args.action,
            params: args.params ?? {},
          },
          AGENT_APPROVAL_TIMEOUT_MS + 30_000,
        ),
      ),
  )

  server.registerTool(
    "wait_for_block",
    {
      title: "Wait for a block",
      description: `Wait until a block's run ends, or timeout_seconds pass (at most ${MAX_WAIT_SECONDS}), then return it as get_block does, with timed_out. Long runs: call it again until timed_out is false, passing the previous call's nextLogOffset as log_offset to get only new log lines. Fails if the window switches to another session meanwhile.`,
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
        // Every read gets what is left of the wait, at least a moment
        const remaining = () => Math.max(deadline - Date.now(), 1000)
        let switched = false
        const read = async (limit: number | undefined, startedIn?: string) => {
          const next = await getBlock(args.block_id, args.log_offset, limit, remaining())
          if (startedIn !== undefined && next.sessionId !== startedIn) {
            switched = true
            throw new Error(
              "The Runbooks window switched to another session while waiting, so this block is no longer the one on screen. Call get_session.",
            )
          }
          return next
        }
        let detail: AgentBlockDetail = await read(0)
        const session = detail.sessionId
        try {
          while (detail.status === "running" && Date.now() < deadline) {
            await sleep(POLL_MS)
            detail = await read(0, session)
          }
          const final = await read(args.log_limit, session)
          return { ...final, timed_out: final.status === "running" }
        } catch (err: unknown) {
          // The window didn't answer before the wait ran out: report what was last seen
          if (!switched && Date.now() >= deadline && detail.status === "running") {
            return { ...detail, timed_out: true }
          }
          throw err
        }
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
