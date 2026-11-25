/**
 * The `showWhenBlock` prop of a <Command>, <Check> or <Finish> block: the
 * block shows only while another block's latest run ended a given way.
 *
 *   <Check id="check-plan" ... />
 *   <Command id="rerun-plan" showWhenBlock={{ id: "check-plan", status: "fail" }} ... />
 *
 * `status` is one of success, warn or fail, or a list of them. The block it
 * names must be one that runs, which the reference graph checks. While that
 * block hasn't run, or is running, the condition doesn't hold.
 *
 * Both the app (web/) and the `runbooks test` CLI use this module, so they
 * agree on when a block shows. Imports nothing, so the renderer can bundle it.
 */

/** The results a `showWhenBlock` condition can name. */
const SHOW_WHEN_BLOCK_STATUSES = ["success", "warn", "fail"] as const

type ShowWhenBlockStatus = (typeof SHOW_WHEN_BLOCK_STATUSES)[number]

/** The `showWhenBlock` prop as a runbook writes it. */
export interface ShowWhenBlockProp {
  readonly id: string
  readonly status: ShowWhenBlockStatus | readonly ShowWhenBlockStatus[]
}

/** A block's `showWhenBlock` condition. */
export interface ShowWhenBlock {
  /** The id of the block whose result the condition reads, as written. */
  readonly id: string
  /** The results of that block's latest run that show this block. */
  readonly statuses: readonly ShowWhenBlockStatus[]
}

export type ParsedShowWhenBlock =
  | { readonly ok: true; readonly condition: ShowWhenBlock | null }
  | { readonly ok: false; readonly error: string }

const EXAMPLE = 'showWhenBlock={{ id: "check-plan", status: "fail" }}'

const isStatus = (value: unknown): value is ShowWhenBlockStatus =>
  typeof value === "string" && (SHOW_WHEN_BLOCK_STATUSES as readonly string[]).includes(value)

/**
 * Check a block's `showWhenBlock` prop. A block without one has no condition,
 * and always shows.
 */
export function parseShowWhenBlock(value: unknown): ParsedShowWhenBlock {
  if (value === undefined) return { ok: true, condition: null }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: `The showWhenBlock prop must be an object, such as ${EXAMPLE}.` }
  }
  const record = value as Record<string, unknown>
  const unknownKeys = Object.keys(record).filter((key) => key !== "id" && key !== "status")
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error: `showWhenBlock takes only id and status, not ${unknownKeys.join(", ")}.`,
    }
  }
  const id = record.id
  if (typeof id !== "string" || id === "") {
    return { ok: false, error: `showWhenBlock needs the id of a block, such as ${EXAMPLE}.` }
  }
  const status = record.status
  const statuses = Array.isArray(status) ? status : [status]
  if (statuses.length === 0 || !statuses.every(isStatus)) {
    return {
      ok: false,
      error: `showWhenBlock's status must be ${SHOW_WHEN_BLOCK_STATUSES.join(", ")}, or a list of them.`,
    }
  }
  return { ok: true, condition: { id, statuses } }
}

/**
 * Whether a block with this condition shows, given the status of the latest
 * run of the block it names: undefined, "pending" or "running" while no run
 * has ended. A block without a condition always shows.
 */
export function showWhenBlockHolds(
  condition: ShowWhenBlock | null,
  status: string | undefined,
): boolean {
  if (!condition) return true
  return isStatus(status) && condition.statuses.includes(status)
}

/** The condition as a sentence fragment, such as `"check-plan" fails`. */
export function describeShowWhenBlock(condition: ShowWhenBlock): string {
  const verbs: Record<ShowWhenBlockStatus, string> = {
    success: "succeeds",
    warn: "ends with a warning",
    fail: "fails",
  }
  return `"${condition.id}" ${condition.statuses.map((status) => verbs[status]).join(" or ")}`
}
