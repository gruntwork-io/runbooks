/**
 * One lifecycle for every credential block, owned by the engine. A provider
 * answers calls; the engine moves the block between these states and the
 * engine protocol carries each one to every client. Confirming a detected
 * credential, asking to sign in again before expiry, unsetting stale
 * variables and saving the session are written once, against these states.
 *
 * The lifecycle starts once the block is trusted and its `outputs` sources
 * are done. Before that the block is `Blocked`, like any other.
 */
import { Schema } from "effect"
import {
  CredentialError,
  type CredentialRequest,
  Requirement,
} from "../../../../blocks/core/contract.ts"
import type { BlockStatus } from "../../../../blocks/core/status.ts"
import { Identity, Level, Method, Target } from "./provider.ts"

/** How long before expiry the block asks to sign in again: 5 minutes, as today. */
export const EXPIRY_WARNING_MILLIS = 5 * 60_000

/** A sign-in method as the view draws it: the provider's method with the block's defaults filled in. */
export const MethodView = Schema.Struct({
  ...Method.fields,
  /** From the block's `methodDefaults`. Never holds a secret field. */
  defaults: Schema.Record(Schema.String, Schema.String),
})
export type MethodView = typeof MethodView.Type

export const SignInPrompt = Schema.Union([
  Schema.TaggedStruct("OpenUrl", { url: Schema.String, code: Schema.optionalKey(Schema.String) }),
  Schema.TaggedStruct("ShowCode", { code: Schema.String }),
  Schema.TaggedStruct("Waiting", {}),
])
export type SignInPrompt = typeof SignInPrompt.Type

export const CredentialState = Schema.Union([
  Schema.TaggedStruct("Detecting", {}),
  /** A login was found in a source and the block pins nothing, so the person confirms it. */
  Schema.TaggedStruct("Found", { identity: Identity, source: Schema.String }),
  Schema.TaggedStruct("SignedOut", {
    methods: Schema.Array(MethodView),
    defaultMethod: Schema.optionalKey(Schema.String),
    /** Why the last attempt did not sign in: cancelled, access denied. */
    lastError: Schema.optionalKey(CredentialError),
  }),
  Schema.TaggedStruct("SigningIn", {
    method: Schema.String,
    prompt: Schema.optionalKey(SignInPrompt),
  }),
  /**
   * One level is being chosen. Before sign-in (GitAuth's provider and host)
   * there is no identity yet.
   */
  Schema.TaggedStruct("ChoosingTarget", {
    level: Level,
    options: Schema.Array(Target),
    /** Levels chosen so far, by level name. */
    chosen: Schema.Record(Schema.String, Target),
    identity: Schema.optionalKey(Identity),
  }),
  Schema.TaggedStruct("RequirementNotMet", {
    identity: Identity,
    unmet: Schema.Array(Requirement),
  }),
  Schema.TaggedStruct("Ready", { identity: Identity, source: Schema.String }),
  /** Within `EXPIRY_WARNING_MILLIS` of expiry, or past it. `identity.expiresAt` says which. */
  Schema.TaggedStruct("Expired", { identity: Identity }),
  /** The provider cannot serve the block: its tool is missing, its binary failed its hash. */
  Schema.TaggedStruct("Unavailable", { error: CredentialError }),
])
export type CredentialState = typeof CredentialState.Type
export type CredentialStateTag = CredentialState["_tag"]

/** What a person or agent may ask of a credential block. The engine refuses one its state does not allow. */
export const CredentialAction = Schema.Union([
  /** Use the login that was found. */
  Schema.TaggedStruct("Confirm", {}),
  /** Do not use it; show the sign-in methods. */
  Schema.TaggedStruct("Decline", {}),
  Schema.TaggedStruct("SignIn", {
    method: Schema.String,
    /** Secret fields travel from the client to the engine and never back. */
    fields: Schema.Record(Schema.String, Schema.Redacted(Schema.String)),
  }),
  Schema.TaggedStruct("Cancel", {}),
  Schema.TaggedStruct("ChooseTarget", { level: Schema.String, id: Schema.String }),
  /** Look in the detection sources again. */
  Schema.TaggedStruct("CheckAgain", {}),
  Schema.TaggedStruct("SignOut", {}),
])
export type CredentialAction = typeof CredentialAction.Type

/**
 * Every move the engine may make. The engine's tests check each transition
 * it makes against this table.
 */
export const TRANSITIONS: {
  readonly [S in CredentialStateTag]: ReadonlyArray<CredentialStateTag>
} = {
  Detecting: ["Found", "Ready", "ChoosingTarget", "SignedOut", "RequirementNotMet", "Unavailable"],
  Found: ["Ready", "ChoosingTarget", "SignedOut"],
  SignedOut: ["SigningIn", "ChoosingTarget", "Detecting"],
  SigningIn: ["Ready", "ChoosingTarget", "RequirementNotMet", "SignedOut", "Unavailable"],
  ChoosingTarget: ["ChoosingTarget", "SigningIn", "Ready", "RequirementNotMet", "SignedOut"],
  RequirementNotMet: ["SigningIn", "Detecting", "SignedOut"],
  Ready: ["Expired", "ChoosingTarget", "SignedOut"],
  Expired: ["SigningIn", "Detecting", "SignedOut"],
  Unavailable: ["Detecting", "SignedOut"],
}

/**
 * The block's status for every client that does not draw the auth view:
 * dependents, the progress bar, the CLI and MCP. The block's env and
 * outputs exist only while it is `Done`, so `Expired` withdraws them.
 */
export function statusOf(state: CredentialState): BlockStatus {
  switch (state._tag) {
    case "Detecting":
    case "SigningIn":
      return { _tag: "Running" }
    case "Found":
    case "SignedOut":
    case "ChoosingTarget":
      return { _tag: "Idle" }
    case "Ready":
      return { _tag: "Done", outcome: "success" }
    case "RequirementNotMet":
      return {
        _tag: "Failed",
        error: new CredentialError({
          kind: "requirementNotMet",
          message: "The signed-in identity does not hold what the block requires.",
          unmet: state.unmet,
        }),
      }
    case "Expired":
      return {
        _tag: "Failed",
        error: new CredentialError({ kind: "expired", message: "The credential has expired." }),
      }
    case "Unavailable":
      return { _tag: "Failed", error: state.error }
  }
}

/**
 * Open decision 7: a detected login is used with no click when the block
 * pins what it should match, and waits in `Found` for confirmation when the
 * block pins nothing. Ruling "always confirm" makes this `true`; "never
 * confirm" makes it `false`.
 */
export function confirmsDetected(request: Pick<CredentialRequest, "pins">): boolean {
  return Object.keys(request.pins).length === 0
}
