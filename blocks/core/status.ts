/**
 * One status for every block that has a lifecycle. The engine moves a block
 * between these; a block never sets its own. Outputs and environment
 * contributions exist exactly while a block is `Done`.
 */
import type { BlockId, Capability, TaskError } from "./contract.ts"

/** Why a block cannot start yet. */
export type Blocker =
  /** A referenced block is not done. */
  | { readonly _tag: "WaitingFor"; readonly block: BlockId; readonly capability: Capability }
  /** The session is not trusted, so nothing runs. */
  | { readonly _tag: "Untrusted" }

/** How a done block finished. A warning (exit 2) still satisfies `dependsOn` and `envFrom`. */
export type Outcome = "success" | "warning"

export type BlockStatus =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Blocked"; readonly by: ReadonlyArray<Blocker> }
  /** A form, or a task's own form, has fields that are empty or invalid. */
  | { readonly _tag: "NeedsInput"; readonly fields: ReadonlyArray<string> }
  | { readonly _tag: "Running" }
  | { readonly _tag: "Done"; readonly outcome: Outcome }
  | { readonly _tag: "Failed"; readonly error: TaskError }

export type BlockStatusTag = BlockStatus["_tag"]
