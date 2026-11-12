/**
 * What a simulated <Command> or <Check> block's script prints, how it ends,
 * and what it publishes, from a scenario's `scripts`, by the block's id:
 *
 *   scripts:
 *     set-settings:
 *       log: Let anyone post to the group.
 *     ready:
 *       outputs:
 *         path: "{{ .outputs.account.CODE_PATH }}"
 *     signed-in:
 *       status: fail
 *       log:
 *         - You're signed in to 444455556666.
 *         - Sign in to the new account instead.
 *
 * Outputs are templates rendered like the block's `env` prop, so they read
 * the same inputs and outputs the block does.
 */
import type { ExecStatusEvent } from "../../types.ts"
import { isRecord, simulationError } from "./file.ts"

export interface SimulatedScript {
  readonly status: ExecStatusEvent["status"]
  /** The lines the script prints. */
  readonly log: readonly string[]
  /** What the script writes to $RUNBOOK_OUTPUT, as templates. */
  readonly outputs: Readonly<Record<string, string>>
  /** How long the script takes, to show it running. */
  readonly delayMs: number
  /** The keys as simulation.yml gives them, for a scenario that extends this one to replace some. */
  readonly raw: Readonly<Record<string, unknown>>
}

const STATUSES: readonly ExecStatusEvent["status"][] = ["success", "warn", "fail"]

/** The exit code a script that ends this way exits with, as the executor reads it. */
const EXIT_CODES: Readonly<Record<ExecStatusEvent["status"], number>> = {
  success: 0,
  fail: 1,
  warn: 2,
}

/**
 * The key a scenario's `scripts` holds the block `blockId`'s run under. `-`
 * and `_` name the same block, as they do in a block's outputs, so
 * `set-settings` and `set_settings` answer the same block.
 */
export const scriptKey = (blockId: string) => blockId.replace(/-/g, "_")

export function readScript(raw: unknown, where: string): SimulatedScript {
  if (!isRecord(raw)) throw simulationError(`${where} must be a map.`)
  const status = raw.status ?? "success"
  if (!STATUSES.includes(status as ExecStatusEvent["status"])) {
    throw simulationError(`${where}.status must be one of ${STATUSES.join(", ")}.`)
  }
  const log = raw.log ?? []
  const lines = typeof log === "string" ? log.split("\n") : log
  if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
    throw simulationError(`${where}.log must be text or a list of lines.`)
  }
  const outputs = raw.outputs ?? {}
  if (
    !isRecord(outputs) ||
    !Object.values(outputs).every((value) => ["string", "number", "boolean"].includes(typeof value))
  ) {
    throw simulationError(`${where}.outputs must map each output to text.`)
  }
  if (raw.delayMs !== undefined && typeof raw.delayMs !== "number") {
    throw simulationError(`${where}.delayMs must be a number of milliseconds.`)
  }
  return {
    status: status as ExecStatusEvent["status"],
    log: lines as string[],
    outputs: Object.fromEntries(
      Object.entries(outputs).map(([key, value]) => [key, String(value)]),
    ),
    delayMs: typeof raw.delayMs === "number" ? raw.delayMs : 0,
    raw,
  }
}

/** How the simulated script ends, as a real run would report it. */
export function simulatedStatus(script: SimulatedScript): ExecStatusEvent {
  return { status: script.status, exitCode: EXIT_CODES[script.status] }
}
