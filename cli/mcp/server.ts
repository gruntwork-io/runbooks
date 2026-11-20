/**
 * MCP server for running runbooks headless: lets an AI agent open a runbook,
 * read its blocks and inputs, set inputs, run blocks and read their results.
 *
 * Each open runbook is a RunbookSession, the test runner's engine run one
 * block at a time. Tool results are JSON text.
 */
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server"
import { z } from "zod"
import { RUNBOOKS_VERSION } from "../../src/runbooks-version.ts"
import { errorMessage } from "../../src/errors/message.ts"
import { RunbookSession, DEFAULT_TIMEOUT_MS } from "./session.ts"

const SERVER_INSTRUCTIONS = `Runs Gruntwork Runbooks (runbook.mdx) headless, one block at a time.
Workflow: open_runbook -> run_block / run_all, which stop at each Inputs or Template form you haven't reviewed -> read that form's fields, descriptions and defaults, then set_inputs or confirm_inputs -> continue -> get_block for logs, outputs and blocked_by -> close_runbook.
Review each form in the context of the block that uses it: defaults are not reviewed values, and some (an empty list of regions, say) have consequences the field's description explains. Ask the user when a value isn't clear.
Blocks run real scripts on this machine with the user's credentials and can create, change or destroy real cloud resources. Opening a runbook runs nothing. Confirm with the user before running blocks that change infrastructure.
Results come from the Runbooks test runner's engine, which differs from the desktop app in places; every open_runbook result lists the limitations.`

const RUNS_SCRIPTS =
  "WARNING: this executes the block for real. Command, Check, Finish and Prerequisites blocks run scripts on this machine with the user's environment and credentials; they can create, change or destroy real cloud resources and are not sandboxed or reversible."

const sessionId = z.string().describe("The session_id open_runbook returned")
const logChars = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("How many characters of log to return, from the end (default 8000)")

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

function failure(e: unknown): CallToolResult {
  return { content: [{ type: "text", text: errorMessage(e) }], isError: true }
}

/** Create the server. Each server holds its own sessions. */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "runbooks", version: RUNBOOKS_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  )
  const sessions = new Map<string, RunbookSession>()
  let nextId = 1

  const session = (id: string): RunbookSession => {
    const s = sessions.get(id)
    if (!s) {
      const open = [...sessions.keys()]
      throw new Error(
        `No open session "${id}".${open.length > 0 ? ` Open sessions: ${open.join(", ")}` : " Call open_runbook first."}`,
      )
    }
    return s
  }

  const run = async (fn: () => unknown): Promise<CallToolResult> => {
    try {
      return json(await fn())
    } catch (e: unknown) {
      return failure(e)
    }
  }

  server.registerTool(
    "open_runbook",
    {
      title: "Open a runbook",
      description:
        "Open a local runbook (a runbook.mdx file or the directory holding it) and start a session. Parses it and lists its blocks (id, type, status, blocked_by), its input variables with types, defaults and current values, and the limitations of running it headless. Runs nothing. Remote URLs aren't supported: clone the repository and pass the local path.",
      inputSchema: z.object({
        path: z.string().describe("Path to runbook.mdx or the directory that holds it"),
        working_dir: z
          .string()
          .optional()
          .describe(
            "Directory scripts start in and generated files go under (in generated/). Default: a new temporary directory, kept after close_runbook",
          ),
        timeout_seconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Time limit for each script (default ${DEFAULT_TIMEOUT_MS / 1000})`),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Environment variables for every block, on top of the server's environment. Don't put secrets here; prefer credentials already in the environment or a CLI sign-in",
          ),
        inputs: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Initial input values, keyed inputsBlockId.VariableName"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      run(async () => {
        const id = `rb-${nextId++}`
        const s = await RunbookSession.open(id, args.path, {
          ...(args.working_dir ? { workingDir: args.working_dir } : {}),
          ...(args.timeout_seconds ? { timeoutMs: args.timeout_seconds * 1000 } : {}),
          ...(args.env ? { env: args.env } : {}),
          ...(args.inputs ? { inputs: args.inputs } : {}),
        })
        sessions.set(id, s)
        return s.describe()
      }),
  )

  server.registerTool(
    "get_runbook",
    {
      title: "Show a runbook session",
      description:
        "The session's blocks with their current status and blocked_by reasons, its inputs and their values, and its limitations: the same view open_runbook returns, as it is now.",
      inputSchema: z.object({ session_id: sessionId }),
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => session(args.session_id).describe()),
  )

  server.registerTool(
    "set_inputs",
    {
      title: "Set input values",
      description:
        'Set input variables, keyed inputsBlockId.VariableName (e.g. {"config.Region": "eastus"}). Merges with values set before unless replace is true; variables never set keep their defaults. Each value set counts as reviewed; with replace, only the values given do. Returns validation errors for every value and the inputs as they now stand. Runs nothing.',
      inputSchema: z.object({
        session_id: sessionId,
        values: z.record(z.string(), z.unknown()).describe("Values by inputsBlockId.VariableName"),
        replace: z.boolean().optional().describe("Drop the values set before (default false)"),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => session(args.session_id).setInputs(args.values, args.replace ?? false)),
  )

  server.registerTool(
    "confirm_inputs",
    {
      title: "Confirm a form",
      description:
        "Accept an Inputs or Template form's values as they stand, defaults included, as a person does by reading the form and moving on. Only after reading each field's description: run_block and run_all stop at a form until its values are set or confirmed. Runs nothing.",
      inputSchema: z.object({
        session_id: sessionId,
        block_id: z.string().describe("The Inputs or Template block's id"),
      }),
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => session(args.session_id).confirmInputs(args.block_id)),
  )

  server.registerTool(
    "run_block",
    {
      title: "Run one block",
      description: `Run one block and wait for it to finish, then return its status (success, warn, fail, timeout, skipped, blocked, error, config_error, valid, unsupported), exit code, logs, outputs and blocked_by. A blocked block, or one that can't run headless (pull request blocks), is not run and the result says why. Neither is a block that reads a form (Inputs or Template, itself included) whose values haven't all been set or confirmed: it returns status needs_review with that form's fields. ${RUNS_SCRIPTS}`,
      inputSchema: z.object({
        session_id: sessionId,
        block_id: z.string().describe("The block's id prop"),
        env_prefix: z
          .string()
          .optional()
          .describe("Auth blocks only: read credentials from variables with this prefix first"),
        set_outputs: z
          .record(z.string(), z.string())
          .optional()
          .describe("Iframe blocks only: the outputs the page would set"),
        log_chars: logChars,
      }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      run(() =>
        session(args.session_id).runBlock(args.block_id, {
          ...(args.env_prefix ? { envPrefix: args.env_prefix } : {}),
          ...(args.set_outputs ? { setOutputs: args.set_outputs } : {}),
          ...(args.log_chars !== undefined ? { logChars: args.log_chars } : {}),
        }),
      ),
  )

  server.registerTool(
    "run_all",
    {
      title: "Run blocks in order",
      description: `Run blocks in document order, from from_block (default the first), one after another, skipping blocks that already succeeded or were skipped unless rerun is true. Stops at the first block that fails, times out, is blocked or errors, and says which. Also stops at each form (Inputs or Template) whose values, defaults included, haven't been set or confirmed, before anything that reads it runs, and returns the form's fields to review. Pull request blocks are not run and are reported as unsupported. ${RUNS_SCRIPTS} Prefer run_block when each step needs review.`,
      inputSchema: z.object({
        session_id: sessionId,
        from_block: z.string().optional().describe("Block id to start from"),
        rerun: z.boolean().optional().describe("Run blocks that already succeeded again"),
      }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    (args) =>
      run(() =>
        session(args.session_id).runAll({
          ...(args.from_block ? { fromId: args.from_block } : {}),
          ...(args.rerun ? { rerun: true } : {}),
        }),
      ),
  )

  server.registerTool(
    "skip_block",
    {
      title: "Skip a block",
      description:
        "Mark a block as skipped without running it or checking its configuration. Use it for pull request blocks and for checks that don't apply. Refused for auth blocks (the blocks that use them would stay blocked or run without credentials), for Inputs blocks (review them instead), and for a block that already ran to completion (its outputs may be in use). The result lists the blocks that wait on the skipped one and which of its outputs they read: they stay blocked unless those values come from elsewhere.",
      inputSchema: z.object({ session_id: sessionId, block_id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => session(args.session_id).skipBlock(args.block_id)),
  )

  server.registerTool(
    "get_block",
    {
      title: "Show a block",
      description:
        "One block in full: status, what it depends on (inputs, auth block, dependsOn), blocked_by reasons, its last run's exit code, error and logs, its outputs, how it behaves headless, and template syntax the headless renderer won't handle.",
      inputSchema: z.object({ session_id: sessionId, block_id: z.string(), log_chars: logChars }),
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => session(args.session_id).getBlock(args.block_id, args.log_chars)),
  )

  server.registerTool(
    "get_outputs",
    {
      title: "Show block outputs",
      description:
        "Every block's outputs so far, by block id. Sensitive outputs show as <redacted>.",
      inputSchema: z.object({ session_id: sessionId }),
      annotations: { readOnlyHint: true },
    },
    (args) => run(() => session(args.session_id).getOutputs()),
  )

  server.registerTool(
    "close_runbook",
    {
      title: "Close a runbook session",
      description:
        "Forget a session's state (outputs, exported variables, credentials). Files in its working directory stay.",
      inputSchema: z.object({ session_id: sessionId }),
      annotations: { readOnlyHint: true },
    },
    (args) =>
      run(() => {
        const s = session(args.session_id)
        sessions.delete(args.session_id)
        return { closed: args.session_id, working_dir: s.workingDir }
      }),
  )

  return server
}
