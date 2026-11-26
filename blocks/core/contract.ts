/**
 * The block contract. A block is a value of one of four types: it has no
 * React and does no I/O of its own. It asks for Effect services, so the app,
 * the CLI and MCP run the same code.
 *
 * This file imports `effect` only. Status, blockers and the form live beside
 * it in `status.ts` and `form.ts`.
 */
import type { Effect, Option, Redacted } from "effect"
import { Schema, SchemaGetter, Stream } from "effect"
import type { FieldValue, FormSpec } from "./form.ts"

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
 * The one id comparison: a hyphen and an underscore are the same, and case
 * counts. A Go template reads a hyphen as subtraction, so `id="create-account"`
 * is read as `.outputs.create_account`.
 */
const sameIdAs = SchemaGetter.transform((written: string) => written.replaceAll("-", "_"))

/**
 * What a block's id may hold: letters, digits, `-` and `_`. It names the
 * block's credential state folder, so a `/` or a `.` would let it reach
 * outside its session's folder, or share another block's.
 */
export const ID_WORD = /^[A-Za-z0-9_-]+$/

/** The `ID_WORD` check, with the message a person reads. */
export const isIdWord = Schema.isPattern(ID_WORD, {
  message: "an id is letters, digits, `-` and `_`, such as deploy-vpc",
})

/**
 * A block's id, normalized as it decodes, so two ids compare with `===`
 * wherever they came from: a prop, a template reference, a test file, an MCP
 * call. It encodes to the normalized form.
 */
export const BlockId = Schema.String.check(isIdWord).pipe(
  Schema.decode({ decode: sameIdAs, encode: sameIdAs }),
  Schema.brand("BlockId"),
)
export type BlockId = typeof BlockId.Type

/** A path relative to the runbook's folder, checked to stay inside it. */
export const RunbookPath = Schema.NonEmptyString.pipe(Schema.brand("RunbookPath"))
export type RunbookPath = typeof RunbookPath.Type

/**
 * The text of each file a block names in `runbookFiles`, as the engine read
 * and hashed it when the runbook opened. A file is keyed by the path as the
 * block named it; each file in a named folder, by its path joined to the
 * folder's.
 */
export type RunbookTexts = ReadonlyMap<string, string>

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

/** The props of `P` whose decoded value is text. */
export type TextProp<P> = {
  readonly [K in keyof P]-?: NonNullable<P[K]> extends string ? K : never
}[keyof P] &
  string

/**
 * Where a task's script is: a prop that holds its text, or a file it names
 * in `runbookFiles`. A script runs as written and reads values only from its
 * environment, so the parser reads no `{{ }}` in it as a reference: it makes
 * no edge, and the text is another tool's, such as docker's `{{.Names}}`.
 */
export type ScriptSource<P> =
  | { readonly _tag: "Prop"; readonly prop: TextProp<P> }
  | { readonly _tag: "File"; readonly path: RunbookPath }

// ---------------------------------------------------------------------------
// What a block declares
// ---------------------------------------------------------------------------

/** An output of a task or credential block, which its run or provider gives. */
export interface OutputDecl {
  /** A sensitive value is redacted in every event, log and saved session. */
  readonly sensitive: boolean
}

/** The output keys a task or credential block may publish, by key. */
export type OutputDecls<K extends string> = { readonly [Key in K]: OutputDecl }

/**
 * An output of a form block: the value of one of its fields, as a task's
 * template reads that field (an empty one is `""`, `[]` or `{}`). It is
 * sensitive exactly when its field is, since the field already says whether
 * the value is a secret: DirPicker's `PATH` is its `path` field.
 */
export interface FormOutputDecl {
  /**
   * The field the output carries. A form whose `fields` lack it is a
   * configuration error in the block (`badProp`), found when the session
   * opens: the block is misconfigured and never done.
   */
  readonly field: string
}

/** A form block's outputs, by output name. Several may carry one field. */
export type FormOutputDecls = { readonly [output: string]: FormOutputDecl }

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
   * The parser calls it while it parses, so it must not throw: a prop that
   * names a file decodes as `RunbookPath` in `props`, and a bad one is a
   * `badProp` error at its line.
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

/**
 * A folder the engine sets for a session. No client names one.
 * - `runbook`: the folder the runbook is in.
 * - `working`: the session's own folder. A run starts here, and a clone goes here.
 * - `generated`: where generated files go, `generated` in the working folder.
 * - `repository`: the repository the task names with `repository`.
 */
export const Root = Schema.Literals(["runbook", "working", "generated", "repository"])
export type Root = typeof Root.Type

/** A path a task named that leaves its root, as written or through a symbolic link. */
export class PathOutsideRoot extends Schema.TaggedError<PathOutsideRoot>()("PathOutsideRoot", {
  root: Root,
  /** As the task named it. */
  path: Schema.String,
  message: Schema.String,
}) {}

/** Why a task did not finish. A closed set; a client branches on the tag. */
export const TaskError = Schema.Union([
  PropError,
  TaskBlocked,
  TaskFailed,
  TaskCancelled,
  TaskTimedOut,
  PathOutsideRoot,
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

/** A path a task names, relative to one of the roots. An absolute one must still be inside it. */
export interface RootedPath {
  readonly root: Root
  readonly path: string
}

/** The session's roots, as absolute paths. The repository's is `TaskInput.repository`. */
export type Roots = { readonly [R in Exclude<Root, "repository">]: string }

/**
 * The outputs a task's templates read (`{{ .outputs.<id>.<key> }}`), by
 * block, then key, as the blocks last published them. Only the blocks the
 * task names are here. Every value is redacted, a sensitive one or not.
 */
export type BlockOutputs = ReadonlyMap<BlockId, ReadonlyMap<string, Redacted.Redacted<string>>>

/**
 * The form values a task reads (`{{ .inputs.<name> }}`), by field name: its
 * `inputsId` forms' in order, then its own form's, a later one winning.
 * Every value is redacted, a sensitive one or not, so a block that prints
 * what it got shows none of them, and no block needs to know which fields
 * are sensitive. A block unwraps the one it needs with `Redacted.value`.
 */
export type TaskValues = ReadonlyMap<string, Redacted.Redacted<FieldValue>>

/**
 * What a task reads that the engine already holds, so it is built with no
 * I/O: instruction mode builds it before trust, and a run gets it as part
 * of its input.
 */
export interface TaskReads {
  readonly values: TaskValues
  readonly outputs: BlockOutputs
  /** The files it names in `runbookFiles`, as the engine read and hashed them when the runbook opened. */
  readonly files: RunbookTexts
}

/** What the engine resolves before a task runs. `N` names the task's `paths`. */
export interface TaskInput<N extends string = never> extends TaskReads {
  readonly env: RunEnv
  /** Where the run starts: the repository the task names, or else the working folder. */
  readonly cwd: string
  readonly roots: Roots
  /** Each path the task names in `paths`, resolved inside its root, as an absolute path. */
  readonly paths: { readonly [Name in N]: string }
  readonly repository: Option.Option<RepositoryRef>
  readonly gitCredential: Option.Option<GitCredentialRef>
}

/**
 * What a run streams to the engine. Outputs are held until the run ends,
 * then published. A run gives environment only through `$RUNBOOK_ENV`,
 * which the engine reads once the run ends well.
 */
export type TaskEvent<K extends string> =
  | { readonly _tag: "Log"; readonly stream: "stdout" | "stderr"; readonly line: string }
  | { readonly _tag: "Output"; readonly key: K; readonly value: string }
  /**
   * The run wrote, changed or removed the file at `path`, an absolute path.
   * The engine lists it in the block's view and tells clients.
   */
  | {
      readonly _tag: "File"
      readonly path: string
      readonly change: "created" | "modified" | "deleted"
    }
  /** The run ends as a warning (exit 2): outputs are still published and later blocks still run. */
  | { readonly _tag: "Warning"; readonly message: string }

/** The exit code that makes a run a warning. */
const WARNING_EXIT_CODE = 2

/**
 * The exit-code table, the one for every task that runs a process (ruled
 * 2026-11-23). A process task ends its run's stream with this, given the
 * process's exit code; the engine then publishes or withdraws.
 *
 * | Exit  | Status  | Outputs and env | Satisfies `dependsOn` and `envFrom` |
 * | 0     | success | published       | yes |
 * | 2     | warning | published       | yes |
 * | other | failure | withdrawn       | no  |
 *
 * A timeout is a failure too: a run the engine stops at its `timeLimit`
 * fails with `TaskTimedOut`.
 */
export const endWithExitCode = (exitCode: number): Stream.Stream<TaskEvent<never>, TaskFailed> => {
  switch (exitCode) {
    case 0:
      return Stream.empty
    case WARNING_EXIT_CODE:
      return Stream.make({
        _tag: "Warning",
        message: `The script exited with code ${WARNING_EXIT_CODE}, a warning: its outputs are kept, and the blocks after it can run.`,
      })
    default:
      return Stream.fail(
        new TaskFailed({ message: `The script exited with code ${exitCode}.`, exitCode }),
      )
  }
}

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
 *
 * Every value it holds is a field, and every output is one of its fields
 * (`FormOutputDecl`), published while it is done. A value that comes from
 * elsewhere, such as an Iframe page's, still goes in a field: a client sets
 * it with `SetValues` on the page's behalf.
 */
export interface FormBlock<P> extends BlockBase<P> {
  readonly class: "form"
  readonly provides: readonly ["values"]
  readonly effects: readonly []
  readonly outputs: (p: P) => FormOutputDecls
  /** Read when the runbook opens, before trust: from the props and the files the block names. */
  readonly fields: (p: P, files: RunbookTexts) => Effect.Effect<FormSpec, PropError>
  readonly plugins: ReadonlyArray<PluginUse<"read">>
  /** Whether it is a progress step, for a block whose props decide. Absent means yes. */
  readonly step?: (p: P) => boolean
}

/** The capabilities a task may add to `run`. */
export type TaskCapability = Exclude<Capability, "run" | "git-credential">

/** Runs on a click and gives outputs, files, and a pass or fail. May carry a form for its own parameters. */
export interface TaskBlock<P, K extends string, R, N extends string = never> extends BlockBase<P> {
  readonly class: "task"
  readonly provides: readonly ["run", ...ReadonlyArray<TaskCapability>]
  readonly effects: ReadonlyArray<MachineEffect>
  readonly outputs: (p: P) => OutputDecls<K>
  /** As a form block's: read when the runbook opens, before trust. */
  readonly fields?: (p: P, files: RunbookTexts) => Effect.Effect<FormSpec, PropError>
  /**
   * Each path the task reads or writes, by name, inside a root. Before a run
   * the engine resolves each one and fails the run with `PathOutsideRoot` if
   * it leaves its root; `run` gets them as `TaskInput.paths`.
   */
  readonly paths?: (p: P, values: TaskValues) => { readonly [Name in N]: RootedPath }
  /**
   * For a task that provides `repository`, the one of its `paths` it makes
   * the repository in. That path must be a folder inside the working folder,
   * not the working folder itself, since the task may delete what is there.
   */
  readonly repository?: N
  /** Its scripts, which run as written (`ScriptSource`). Each `File` source is one of its `runbookFiles`. */
  readonly scripts?: (p: P) => ReadonlyArray<ScriptSource<P>>
  /**
   * How long a run may take, in milliseconds. The engine stops a run still
   * going then, as a cancel does, and the task fails with `TaskTimedOut`.
   * Absent, or undefined for these props: no limit.
   */
  readonly timeLimit?: (p: P) => number | undefined
  /** The one function that gets services. The engine calls it only in a trusted session. */
  readonly run: (p: P, input: TaskInput<N>) => Stream.Stream<TaskEvent<K>, TaskError, R>
  /**
   * What instruction mode shows the person in place of a run, built before
   * trust. Its values and outputs are redacted, as a run's are, and it
   * unwraps none: it cannot tell a sensitive one, and the person sees what
   * it returns.
   */
  readonly instruction: (p: P, reads: TaskReads) => Instruction
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

/** Scopes or roles an identity must hold. The plugin protocol carries the same shape. */
export const Requirement = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("scopes"), scopes: Schema.Array(Schema.String) }),
  Schema.Struct({
    kind: Schema.Literal("roles"),
    roles: Schema.Array(
      Schema.Struct({ role: Schema.String, scope: Schema.optionalKey(Schema.String) }),
    ),
  }),
])
export type Requirement = typeof Requirement.Type

/**
 * Why a credential is not ready. `kind` is a closed set: the provider's
 * kinds (`plugin/credential.schema.json`, `errorKind`), plus
 * `providerFailed` when the provider could not run at all (not installed, a
 * hash mismatch, it exited or broke the protocol) and `unknown` for a kind
 * newer than this app. A client branches on `kind`, never on `message`.
 */
export const CredentialErrorKind = Schema.Literals([
  "notConfigured",
  "unsupportedProtocolVersion",
  "invalidParams",
  "notSignedIn",
  "expired",
  "pinMismatch",
  "requirementNotMet",
  "accessDenied",
  "cancelled",
  "timedOut",
  "network",
  "tlsError",
  "toolMissing",
  "internal",
  "providerFailed",
  "unknown",
])
export type CredentialErrorKind = typeof CredentialErrorKind.Type

export class CredentialError extends Schema.TaggedError<CredentialError>()("CredentialError", {
  kind: CredentialErrorKind,
  message: Schema.String,
  /** For `requirementNotMet`: what the identity lacks. */
  unmet: Schema.optionalKey(Schema.Array(Requirement)),
  /** For `toolMissing`: the tool and where to get it. */
  tool: Schema.optionalKey(Schema.Struct({ name: Schema.String, installUrl: Schema.String })),
}) {}

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
  /**
   * Every environment variable its provider may set for a run. A run gets
   * only these from the block. The engine strips the names of every
   * credential block in the registry from the base environment, so a script
   * gets a credential only from a block it names in `envFrom`. Known without
   * starting the provider, unlike its `describe` answer.
   */
  readonly envNames: ReadonlyArray<string>
  readonly outputs: (p: P) => OutputDecls<string>
  readonly request: (p: P) => CredentialRequest
  readonly instruction: (p: P) => Instruction
}

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

/** Stands for the services a block asks for, so the types below can tell which functions get them. */
interface AskedServices {
  readonly askedServices: "the services a block asks for"
}

/** A block of each class, asking for `AskedServices`, and naming paths. */
type EachClass =
  | DisplayBlock<unknown>
  | FormBlock<unknown>
  | TaskBlock<unknown, string, AskedServices, string>
  | CredentialBlock<unknown>

/** Whether `A` is a function. `never`, which extends every type, is not one. */
type IsFunction<A> = [A] extends [never]
  ? false
  : A extends (...args: never) => unknown
    ? true
    : false

/** The name of each function a block of some class declares. */
type FunctionName<B> = B extends unknown
  ? { [K in keyof B]-?: IsFunction<NonNullable<B[K]>> extends true ? K : never }[keyof B]
  : never

export type BlockFunction = FunctionName<EachClass>

/** What the function named `F` returns, in each class that declares it. */
type ReturnOf<F extends BlockFunction, B = EachClass> = B extends unknown
  ? F extends keyof B
    ? NonNullable<B[F]> extends (...args: never) => infer A
      ? A
      : never
    : never
  : never

/** The services a returned effect or stream asks for. */
type ServicesIn<A> =
  A extends Effect.Effect<unknown, unknown, infer R>
    ? R
    : A extends Stream.Stream<unknown, unknown, infer R>
      ? R
      : never

/** The function named `F` gets no services, so it can do no I/O. */
type GetsNoServices<F extends BlockFunction> = [AskedServices] extends [ServicesIn<ReturnOf<F>>]
  ? false
  : true

/**
 * Whether the engine may call each function a block declares before the
 * person trusts the session. One that may gets no services, only its
 * arguments (props decode with none either), so it does no I/O. One that may
 * not gets its block's services, which the engine holds only for a trusted
 * session. The compiler checks each entry against the function's type, and
 * fails while a block type declares a function this does not list.
 */
export const BEFORE_TRUST = {
  runbookFiles: true,
  outputs: true,
  fields: true,
  paths: true,
  scripts: true,
  timeLimit: true,
  step: true,
  instruction: true,
  request: true,
  run: false,
} as const satisfies { readonly [F in BlockFunction]: GetsNoServices<F> }

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/**
 * Each `define*` is the identity function. It exists so the compiler infers
 * a block's props, output keys and services from the literal, and checks the
 * literal against its class.
 */
export const defineDisplay = <P>(block: DisplayBlock<P>): DisplayBlock<P> => block
export const defineForm = <P>(block: FormBlock<P>): FormBlock<P> => block
export const defineTask = <P, K extends string, R = never, N extends string = never>(
  block: TaskBlock<P, K, R, N>,
): TaskBlock<P, K, R, N> => block
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
