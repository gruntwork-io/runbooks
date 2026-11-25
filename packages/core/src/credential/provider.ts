/**
 * What a credential provider answers. A Rust binary behind the plugin
 * protocol (`plugin/credential.schema.json`) and in-process TypeScript
 * (GitAuth) both implement `CredentialProvider`, so the engine runs one
 * lifecycle for every auth block. A provider answers calls; it never
 * decides a block's state (see `./lifecycle.ts`).
 *
 * These are the engine's types, not the wire's: times are `DateTime`, absent
 * values are absent rather than empty strings, and every value a provider
 * hands back for a run is `Redacted`. The credential client maps the
 * generated wire schemas (`../plugin/generated/credential.ts`) to these.
 */
import type { DateTime, Effect, Option, Redacted, Scope, Stream } from "effect"
import { Context, Schema } from "effect"
import {
  CredentialError,
  type CredentialRequest,
  Requirement,
} from "@runbooks/blocks-core/contract"

export const Target = Schema.Struct({ id: Schema.String, name: Schema.String })
export type Target = typeof Target.Type

export const IdentityKind = Schema.Literals([
  "user",
  "guest",
  "servicePrincipal",
  "serviceAccount",
  "role",
])
export type IdentityKind = typeof IdentityKind.Type

/** The most warnings one identity carries, as the wire's `identity.warnings` allows. */
const MAX_WARNINGS = 10

/** Who is signed in and what is selected. Never a secret: the auth view draws its card from this. */
export const Identity = Schema.Struct({
  /** An ARN, an email, an object id, a login. */
  principal: Schema.String,
  kind: IdentityKind,
  /** The sign-in method that produced it, or the detection source's method. */
  method: Schema.String,
  /** What is selected at each level, by level name: null at an optional level that has none. */
  targets: Schema.Record(Schema.String, Schema.NullOr(Target)),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  /** Shown with the identity, and never fatal: a region that is not enabled. */
  warnings: Schema.optionalKey(
    Schema.Array(Schema.Struct({ message: Schema.String })).check(Schema.isMaxLength(MAX_WARNINGS)),
  ),
})
export type Identity = typeof Identity.Type

/** The most choices one field lists, as the wire's `field.choices` allows. */
const MAX_CHOICES = 1_000

const fieldParts = {
  name: Schema.String,
  label: Schema.String,
  required: Schema.Boolean,
}

/**
 * One input of a sign-in method. A `secret` field is typed into a masked
 * input and travels one way, so it lists no choices.
 */
export const MethodField = Schema.Union([
  Schema.Struct({
    ...fieldParts,
    secret: Schema.Literal(false),
    /** The values the view offers to pick from: AWS profiles. The provider refuses any other. */
    choices: Schema.optionalKey(
      Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String })).check(
        Schema.isMaxLength(MAX_CHOICES),
      ),
    ),
  }),
  Schema.Struct({
    ...fieldParts,
    secret: Schema.Literal(true),
    choices: Schema.optionalKey(
      Schema.Never.annotate({ message: "A secret field lists no choices." }),
    ),
  }),
])
export type MethodField = typeof MethodField.Type

/** The most groups in a method's `oneOf`, and the most names in one group, as the wire allows. */
const MAX_ONE_OF = 10

/** A sign-in method: one tab in the auth view. */
export const Method = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  fields: Schema.Array(MethodField),
  /**
   * Groups of the method's field names. A sign-in gives exactly one field of
   * each group: a client secret or a certificate. The provider checks it.
   */
  oneOf: Schema.optionalKey(
    Schema.Array(
      Schema.Array(Schema.String).check(Schema.isMinLength(2), Schema.isMaxLength(MAX_ONE_OF)),
    ).check(Schema.isMaxLength(MAX_ONE_OF)),
  ),
  /**
   * Why the method cannot be used now: no `az` installed. The view still
   * lists it, with this reason, and the engine refuses a sign-in with it.
   */
  unavailable: Schema.optionalKey(CredentialError),
}).check(
  Schema.makeFilter(
    (method: {
      readonly name: string
      readonly fields: ReadonlyArray<{ readonly name: string }>
      readonly oneOf?: ReadonlyArray<ReadonlyArray<string>>
    }) =>
      (method.oneOf ?? []).flatMap((group, at) =>
        group.flatMap((name, index) =>
          method.fields.some((field) => field.name === name)
            ? []
            : [{ path: ["oneOf", at, index], issue: `${method.name} has no field ${name}.` }],
        ),
      ),
  ),
)
export type Method = typeof Method.Type

/**
 * A level of target: account, role, project, tenant, subscription, host.
 * GitAuth chooses its levels before signing in; the clouds choose theirs
 * after.
 */
export const Level = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  chosen: Schema.Literals(["beforeSignIn", "afterSignIn"]),
  /**
   * The person may choose no target here: an Azure tenant-level sign-in has
   * no subscription. False when absent. A pin always names a target.
   */
  optional: Schema.optionalKey(Schema.Boolean),
})
export type Level = typeof Level.Type

/** What `describe` returns: everything the auth view draws before anything is signed in. */
export const ProviderInfo = Schema.Struct({
  methods: Schema.Array(Method),
  /** In the order they are chosen. */
  levels: Schema.Array(Level),
  /** The detection sources it names itself: cli, adc, gcloud. */
  sources: Schema.Array(Schema.String),
  requirements: Schema.Array(Schema.Literals(["scopes", "roles"])),
  /**
   * Every env and output name it may set. The base environment strips the
   * credential blocks' `envNames` instead: those are known before any
   * provider starts.
   */
  names: Schema.Array(Schema.String),
})
export type ProviderInfo = typeof ProviderInfo.Type

/** A detection source after the engine resolved it: an `outputs` source becomes the values it read. */
export type ResolvedSource =
  | { readonly kind: "env"; readonly prefix: Option.Option<string> }
  | {
      readonly kind: "values"
      readonly values: { readonly [name: string]: Redacted.Redacted<string> }
    }
  | { readonly kind: "named"; readonly name: string }

/** What `detect` and `signIn` check an identity against. */
export interface Constraints {
  readonly pins: CredentialRequest["pins"]
  readonly requirements: ReadonlyArray<Requirement>
}

export interface Detected {
  readonly identity: Identity
  /** The source it was found in: env, cli, adc, or the block it was read from. */
  readonly source: string
}

/** What a sign-in shows the person while it runs, then its identity. */
export type SignInEvent =
  | { readonly _tag: "OpenUrl"; readonly url: string; readonly code: Option.Option<string> }
  | { readonly _tag: "ShowCode"; readonly code: string }
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "SignedIn"; readonly identity: Identity }

/** One value a run gets. A declared name that is not returned is unset. */
export interface CredentialValue {
  readonly name: string
  readonly value: Redacted.Redacted<string>
  /** False for a value the view may show: a region, an account id. */
  readonly sensitive: boolean
  readonly to: ReadonlyArray<"env" | "output">
}

export interface CredentialEnv {
  readonly values: ReadonlyArray<CredentialValue>
  readonly expiresAt: Option.Option<DateTime.Utc>
}

/** One provider instance serves one block. Closing the scope it was opened in signs nothing out. */
export interface CredentialProvider {
  readonly describe: Effect.Effect<ProviderInfo, CredentialError>
  readonly detect: (
    sources: ReadonlyArray<ResolvedSource>,
    constraints: Constraints,
  ) => Effect.Effect<Option.Option<Detected>, CredentialError>
  /** Ends with exactly one `SignedIn`. Interrupting the stream cancels the sign-in. */
  readonly signIn: (
    method: string,
    fields: { readonly [name: string]: Redacted.Redacted<string> },
    constraints: Constraints,
  ) => Stream.Stream<SignInEvent, CredentialError>
  readonly targets: (
    level: string,
    parent: Option.Option<string>,
  ) => Effect.Effect<ReadonlyArray<Target>, CredentialError>
  /** The chosen target id at each level, by level name: null where an optional level has none. */
  readonly select: (targets: {
    readonly [level: string]: string | null
  }) => Effect.Effect<Identity, CredentialError>
  /** The only call that returns secret values. The provider refreshes first if it can. */
  readonly env: Effect.Effect<CredentialEnv, CredentialError>
  /** Drops what the provider holds and deletes the files it wrote. */
  readonly signOut: Effect.Effect<void, CredentialError>
}

export interface ProviderConfig {
  /** A private directory for this block, under the session's state. */
  readonly stateDir: string
  readonly caBundleFile: Option.Option<string>
  readonly proxy: Option.Option<string>
  /** The block's own, from its request: a default region, a default zone. */
  readonly settings: CredentialRequest["settings"]
}

/**
 * Opens a block's provider by the name its block declares. Plugin-backed
 * providers start their binary through `PluginProcess`; in-process ones are
 * constructed. A name with no provider fails with `providerFailed`.
 */
export class CredentialProviders extends Context.Service<
  CredentialProviders,
  {
    readonly open: (
      provider: string,
      config: ProviderConfig,
    ) => Effect.Effect<CredentialProvider, CredentialError, Scope.Scope>
  }
>()("@runbooks/core/credential/CredentialProviders") {}
