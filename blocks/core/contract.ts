/**
 * The block contract. A block is a value of one of four types: it has no
 * React and does no I/O of its own. It asks for Effect services, so the app,
 * the CLI and MCP run the same code.
 *
 * This file imports `effect` only. Status, blockers and the form live beside
 * it in `status.ts` and `form.ts`.
 */
import type { Effect, Option, Redacted, Stream } from "effect"
import { Schema } from "effect"
import type { FormSpec, FormValues } from "./form.ts"

// ---------------------------------------------------------------------------
// Closed sets
// ---------------------------------------------------------------------------

/**
 * How a block gets to done. A closed set: every client switches on it
 * exhaustively, so a fifth class fails the build until the app, the CLI and
 * MCP all handle it.
 */
export const BlockClass = Schema.Literals(["display", "form", "task", "credential"])
export type BlockClass = typeof BlockClass.Type

/** What another block may reference a block for. */
export const Capability = Schema.Literals(["values", "run", "env", "git-credential", "repository"])
export type Capability = typeof Capability.Type

/** What a block may do to the machine. A block that declares `push` is external. */
export const MachineEffect = Schema.Literals([
  "process",
  "files",
  "repository",
  "network",
  "push",
  "browser",
])
export type MachineEffect = typeof MachineEffect.Type

/** The levels a block may use a driver plugin at. Anything beyond `read` makes a task external. */
export const PluginLevel = Schema.Literals(["read", "create", "update", "delete"])
export type PluginLevel = typeof PluginLevel.Type

// ---------------------------------------------------------------------------
// Identifiers and references
// ---------------------------------------------------------------------------

/**
 * A block's id, as the one id comparison normalizes it. Only the parser
 * makes one, after it has checked the id the author wrote.
 */
export const BlockId = Schema.NonEmptyString.pipe(Schema.brand("BlockId"))
export type BlockId = typeof BlockId.Type

/** A path relative to the runbook's folder, checked to stay inside it. */
export const RunbookPath = Schema.NonEmptyString.pipe(Schema.brand("RunbookPath"))
export type RunbookPath = typeof RunbookPath.Type

/** A reference prop's decoded value: one block, or an ordered list of them. */
export type ReferenceValue = BlockId | ReadonlyArray<BlockId>

/** The props of `P` whose decoded value can name other blocks. */
export type ReferenceProp<P> = {
  readonly [K in keyof P]-?: NonNullable<P[K]> extends ReferenceValue ? K : never
}[keyof P] &
  string

/**
 * A block's own reference props, each with the capability its target must
 * provide. The props every block of a class shares (`dependsOn`, `envFrom`,
 * `inputsId`) are the host's and are not listed here.
 */
export type References<P> = { readonly [K in ReferenceProp<P>]?: Capability }

/** One edge of the document's graph, as the parser extracts it. */
export interface Reference {
  /** The prop that names the target, for the error's location. */
  readonly prop: string
  readonly target: BlockId
  readonly capability: Capability
}

// ---------------------------------------------------------------------------
// What a block declares
// ---------------------------------------------------------------------------

export interface OutputDecl {
  /** A sensitive value is redacted in every event, log and saved session. */
  readonly sensitive: boolean
}

/** The output keys a block may publish, by key. */
export type OutputDecls<K extends string> = { readonly [Key in K]: OutputDecl }

/**
 * How a block reads its MDX children. `yaml` names the prop that receives
 * the fenced YAML, parsed, before the props are decoded.
 */
export type ChildrenSpec<P> =
  | { readonly kind: "none" }
  | { readonly kind: "markdown" }
  | { readonly kind: "yaml"; readonly prop: keyof P & string }

/** A driver plugin a form or task uses, and the credential scope it runs under. */
export interface PluginUse<L extends PluginLevel = PluginLevel> {
  /** The plugin's registry name. A runbook cannot name a binary of its own. */
  readonly plugin: string
  readonly levels: ReadonlyArray<L>
  readonly credentialScope: string
}

/** What instruction mode shows instead of running the block. */
export type InstructionStep =
  | { readonly kind: "text"; readonly markdown: string }
  | { readonly kind: "code"; readonly language: string; readonly code: string }
  | { readonly kind: "link"; readonly label: string; readonly url: string }
export type Instruction = ReadonlyArray<InstructionStep>

interface BlockBase<P> {
  /** The MDX tag. */
  readonly name: string
  /** The first app version that has this block, so an older app can say which version a runbook needs. */
  readonly since: string
  /** The block's own props. Decoded once, at parse time; a failure is a configuration error with its line. */
  readonly props: Schema.Codec<P, unknown>
  readonly children: ChildrenSpec<P>
  readonly references: References<P>
  /**
   * Files and folders the block reads from the runbook's folder: its script,
   * its template. The document hashes each, and trust is keyed by the hashes.
   */
  readonly runbookFiles: (p: P) => ReadonlyArray<RunbookPath>
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The block's verdict on one of its props. The parser adds the block and the line. */
export class PropError extends Schema.TaggedError<PropError>()("PropError", {
  prop: Schema.String,
  message: Schema.String,
}) {}

export class TaskBlocked extends Schema.TaggedError<TaskBlocked>()("TaskBlocked", {
  by: Schema.Array(BlockId),
}) {}

export class TaskFailed extends Schema.TaggedError<TaskFailed>()("TaskFailed", {
  message: Schema.String,
  /** The script's exit code, when a process ran. */
  exitCode: Schema.optionalKey(Schema.Int),
}) {}

export class TaskCancelled extends Schema.TaggedError<TaskCancelled>()("TaskCancelled", {}) {}

export class TaskTimedOut extends Schema.TaggedError<TaskTimedOut>()("TaskTimedOut", {
  afterMillis: Schema.Int,
}) {}

/** Why a task did not finish. A closed set; a client branches on the tag. */
export const TaskError = Schema.Union([
  PropError,
  TaskBlocked,
  TaskFailed,
  TaskCancelled,
  TaskTimedOut,
])
export type TaskError = typeof TaskError.Type

// ---------------------------------------------------------------------------
// Running a task
// ---------------------------------------------------------------------------

/** A run's environment. The engine builds it per run; every value is treated as a secret. */
export type RunEnv = { readonly [name: string]: Redacted.Redacted<string> }

/** A repository a task names with `repository`, as the engine registered it. */
export interface RepositoryRef {
  readonly block: BlockId
  readonly path: string
  readonly remoteUrl: Option.Option<string>
}

/** A git credential a task names with `gitAuthId`, resolved by the engine. */
export interface GitCredentialRef {
  readonly block: BlockId
  readonly provider: string
  readonly host: string
  readonly token: Redacted.Redacted<string>
}

/** What the engine resolves before a task runs. */
export interface TaskInput {
  /** The values the task reads: from its `inputsId` targets, then its own form. */
  readonly values: FormValues
  readonly env: RunEnv
  /** The session's working directory, or the repository the task names. */
  readonly cwd: string
  readonly repository: Option.Option<RepositoryRef>
  readonly gitCredential: Option.Option<GitCredentialRef>
}

/** What a run streams to the engine. Outputs and env are held until the run ends, then published. */
export type TaskEvent<K extends string> =
  | { readonly _tag: "Log"; readonly stream: "stdout" | "stderr"; readonly line: string }
  | { readonly _tag: "Output"; readonly key: K; readonly value: string }
  /** A variable the script wrote to `$RUNBOOK_ENV`. */
  | { readonly _tag: "Env"; readonly name: string; readonly value: Redacted.Redacted<string> }
  | {
      readonly _tag: "File"
      readonly path: string
      readonly change: "created" | "modified" | "deleted"
    }
  /** The run ends as a warning (exit 2): outputs are still published and later blocks still run. */
  | { readonly _tag: "Warning"; readonly message: string }

// ---------------------------------------------------------------------------
// The four block types
// ---------------------------------------------------------------------------

/** Gives the runbook nothing. Never a progress step; nothing saved. */
export interface DisplayBlock<P> extends BlockBase<P> {
  readonly class: "display"
  readonly provides: readonly []
  readonly effects: readonly []
}

/**
 * Gives the runbook values. Edited by the person; done when submitted and
 * valid. It may not declare a machine effect, and may read a driver plugin
 * only at `read`.
 */
export interface FormBlock<P, R> extends BlockBase<P> {
  readonly class: "form"
  readonly provides: readonly ["values"]
  readonly effects: readonly []
  readonly outputs: (p: P) => OutputDecls<string>
  readonly fields: (p: P) => Effect.Effect<FormSpec, PropError, R>
  readonly plugins: ReadonlyArray<PluginUse<"read">>
  /** Whether it is a progress step, for a block whose props decide. Absent means yes. */
  readonly step?: (p: P) => boolean
}

/** The capabilities a task may add to `run`. */
export type TaskCapability = Exclude<Capability, "run" | "git-credential">

/** Runs on a click and gives outputs, files, and a pass or fail. May carry a form for its own parameters. */
export interface TaskBlock<P, K extends string, R> extends BlockBase<P> {
  readonly class: "task"
  readonly provides: readonly ["run", ...ReadonlyArray<TaskCapability>]
  readonly effects: ReadonlyArray<MachineEffect>
  readonly outputs: (p: P) => OutputDecls<K>
  readonly fields?: (p: P) => Effect.Effect<FormSpec, PropError, R>
  readonly run: (p: P, input: TaskInput) => Stream.Stream<TaskEvent<K>, TaskError, R>
  readonly instruction: (p: P, input: TaskInput) => Instruction
  readonly plugins: ReadonlyArray<PluginUse>
  readonly step?: (p: P) => boolean
}

/** The settings, pins and sources a credential block's props turn into. The provider answers it. */
export interface CredentialRequest {
  /** Where to look for an existing login. Empty turns detection off. */
  readonly detect: ReadonlyArray<DetectSource>
  /** Keyed by target level: account, role, project, tenant, subscription, host. */
  readonly pins: { readonly [level: string]: string }
  /** Scopes or roles the identity must hold. */
  readonly requirements: ReadonlyArray<Requirement>
  /** Neither secret nor identity: region, zone. */
  readonly settings: { readonly [name: string]: string }
  readonly defaultMethod: Option.Option<string>
  /** Field defaults per sign-in method: sso: { startUrl, region }. */
  readonly methodDefaults: { readonly [method: string]: { readonly [field: string]: string } }
}

export type DetectSource =
  | { readonly kind: "env"; readonly prefix: Option.Option<string> }
  /** An earlier block's outputs. The engine reads them and passes the values. */
  | { readonly kind: "outputs"; readonly from: BlockId }
  /** A source the provider names itself: "cli", "adc", "gcloud". */
  | { readonly kind: "named"; readonly name: string }

export type Requirement =
  | { readonly kind: "scopes"; readonly scopes: ReadonlyArray<string> }
  | {
      readonly kind: "roles"
      readonly roles: ReadonlyArray<{
        readonly role: string
        readonly scope: Option.Option<string>
      }>
    }

/**
 * Gives environment under a named scope, with an expiry. Detected, or
 * obtained through a sign-in method. The block does no I/O: it names a
 * provider and turns its props into one request. The engine runs the
 * lifecycle.
 */
export interface CredentialBlock<P> extends BlockBase<P> {
  readonly class: "credential"
  readonly provides: readonly ["env", ...ReadonlyArray<"git-credential">]
  /** What signing in may do: open a browser, reach the network, write its state directory. */
  readonly effects: ReadonlyArray<MachineEffect>
  /** The environment scope it fills: "aws". */
  readonly scope: string
  /** The credential provider that serves it, by registry name. */
  readonly provider: string
  readonly outputs: (p: P) => OutputDecls<string>
  readonly request: (p: P) => CredentialRequest
  readonly instruction: (p: P) => Instruction
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/**
 * Each `define*` is the identity function. It exists so the compiler infers
 * a block's props, output keys and services from the literal, and checks the
 * literal against its class.
 */
export const defineDisplay = <P>(block: DisplayBlock<P>): DisplayBlock<P> => block
export const defineForm = <P, R = never>(block: FormBlock<P, R>): FormBlock<P, R> => block
export const defineTask = <P, K extends string, R = never>(
  block: TaskBlock<P, K, R>,
): TaskBlock<P, K, R> => block
export const defineCredential = <P>(block: CredentialBlock<P>): CredentialBlock<P> => block

/**
 * A second MDX tag for a block, with some props locked: GitHubAuth is GitAuth
 * with `provider="github"`. One registry line each.
 */
export interface Alias<P> {
  readonly name: string
  readonly since: string
  readonly of: string
  /** Props the alias sets. An author who sets one of them gets a configuration error. */
  readonly locked: Partial<P>
}
