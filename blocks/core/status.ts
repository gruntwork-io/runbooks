/**
 * One status for every block that has a lifecycle. The engine moves a block
 * between these; a block never sets its own. Outputs and environment
 * contributions exist exactly while a block is `Done`. Defined as schemas
 * because the engine protocol carries them to every client.
 */
import { Schema } from "effect"
import { BlockId, Capability, CredentialError, TaskError } from "./contract.ts"

/** Why a block cannot start yet. */
export const Blocker = Schema.Union([
  /** A referenced block is not done. */
  Schema.TaggedStruct("WaitingFor", { block: BlockId, capability: Capability }),
  /** The session is not trusted, so nothing runs. */
  Schema.TaggedStruct("Untrusted", {}),
])
export type Blocker = typeof Blocker.Type

/** How a done block finished. A warning (exit 2) still satisfies `dependsOn` and `envFrom`. */
export const Outcome = Schema.Literals(["success", "warning"])
export type Outcome = typeof Outcome.Type

export const BlockStatus = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Blocked", { by: Schema.Array(Blocker) }),
  /** A form, or a task's own form, has fields that are empty or invalid. */
  Schema.TaggedStruct("NeedsInput", { fields: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Running", {}),
  Schema.TaggedStruct("Done", { outcome: Outcome }),
  Schema.TaggedStruct("Failed", { error: Schema.Union([TaskError, CredentialError]) }),
  /** Its configuration has errors, which its document node holds. It never runs; the others do. */
  Schema.TaggedStruct("Misconfigured", {}),
])
export type BlockStatus = typeof BlockStatus.Type

export type BlockStatusTag = BlockStatus["_tag"]
