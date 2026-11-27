/**
 * A runbook, parsed once in the core into data. Nothing in it is ever
 * evaluated: the renderer walks `tree`, and the engine reads `blocks` and
 * `edges`. Every client gets the same document.
 */
import { Result, Schema, SchemaGetter } from "effect"
import {
  BlockClass,
  BlockId,
  Capability,
  RunbookPath,
  type RunbookTexts,
} from "@runbooks/blocks-core/contract"
import { templateText } from "@runbooks/blocks-core/form"
import { byPlace, ConfigError, ConfigWarning, Span } from "./configError.ts"
import { parseValueTemplate } from "./valueTemplate.ts"

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

/** `sha256:` and 64 lowercase hex digits. */
export const ContentHash = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)).pipe(
  Schema.brand("ContentHash"),
)
export type ContentHash = typeof ContentHash.Type

/**
 * What trust and resume are keyed by. A change to the runbook or to any file
 * a block names (its script, its template folder) changes `combined`.
 */
export const DocumentHash = Schema.Struct({
  runbook: ContentHash,
  /** Each file or folder in a block's `runbookFiles`. A folder hashes its sorted tree. */
  files: Schema.Record(RunbookPath, ContentHash),
  /** Over `runbook` and `files`, in path order. */
  combined: ContentHash,
})
export type DocumentHash = typeof DocumentHash.Type

// ---------------------------------------------------------------------------
// Environment variable names
// ---------------------------------------------------------------------------

/**
 * Whether Runbooks sets `name` for every run: `RUNBOOK_OUTPUT`, `RUNBOOK_ENV`
 * and the rest of the `RUNBOOK_` names, `GENERATED_FILES` and `REPO_FILES`.
 * Nothing else a run's environment is built from may set one.
 */
export const isReservedEnvName = (name: string): boolean =>
  name.startsWith("RUNBOOK_") || name === "GENERATED_FILES" || name === "REPO_FILES"

/** What POSIX allows a shell to export. */
const EXPORTABLE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Why a run's environment cannot take `name`, if it cannot. */
export const envNameProblem = (name: string): "notExportable" | "reserved" | undefined =>
  !EXPORTABLE.test(name) ? "notExportable" : isReservedEnvName(name) ? "reserved" : undefined

const ENV_NAME_PROBLEMS = {
  notExportable:
    "not a variable name. Use letters, digits and underscores, and don't start with a digit",
  reserved: "a variable Runbooks sets for every script. Pick another name",
} as const

/** An `env` value: text, or a number or boolean, which is its text as a template prints it. */
const EnvValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform(templateText),
    encode: SchemaGetter.transform((text) => text),
  }),
)

/**
 * A block's `env`: variables by name, each value a template the engine fills
 * in when a run starts (`./valueTemplate.ts`). Each name is checked here, on
 * the whole record, because a record's key schema drops a key it refuses
 * rather than failing, which would leave the variable silently unset.
 */
const EnvProp = Schema.Record(Schema.String, EnvValue).check(
  Schema.makeFilter((env: { readonly [name: string]: string }) =>
    Object.entries(env).flatMap(([name, value]) => {
      const problem = envNameProblem(name)
      if (problem !== undefined) return [{ path: [name], issue: ENV_NAME_PROBLEMS[problem] }]
      const template = parseValueTemplate(value)
      return Result.isFailure(template) ? [{ path: [name], issue: template.failure.message }] : []
    }),
  ),
)

// ---------------------------------------------------------------------------
// Shared props
// ---------------------------------------------------------------------------

/**
 * The props the host owns for every block of a class, decoded by the parser
 * so no block repeats them. Which apply depends on the class and on the
 * block's effects; one that does not apply is an `unknownProp` warning.
 */
/**
 * One block's id, or a list of them, decoded to the list. The docs give
 * `inputsId` and `dependsOn` as `string | string[]`, and runbooks write both
 * (`inputsId="config"` and `inputsId={["config", "region"]}`).
 */
const OneOrMoreIds = Schema.Union([BlockId, Schema.Array(BlockId)]).pipe(
  Schema.decodeTo(Schema.toType(Schema.Array(BlockId)), {
    decode: SchemaGetter.transform((ids) => (typeof ids === "string" ? [ids] : ids)),
    encode: SchemaGetter.transform((ids) => ids),
  }),
)

export const SharedProps = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  /** Fold the block to its header once it is done. */
  autoCollapse: Schema.optionalKey(Schema.Boolean),
  /** Any block: the forms whose values it reads (capability `values`). A display block reads them into its text. */
  inputsId: Schema.optionalKey(OneOrMoreIds),
  /** Task: blocks that must be done first (capability `run`). */
  dependsOn: Schema.optionalKey(OneOrMoreIds),
  /** Task with the `process` effect: environment sources, in order, later winning (capability `env`). */
  envFrom: Schema.optionalKey(OneOrMoreIds),
  /** Task with the `process` effect: variables set last, before the reserved `RUNBOOK_*` ones. Each value's `{{ }}` is filled in when a run starts. */
  env: Schema.optionalKey(EnvProp),
})
export type SharedProps = typeof SharedProps.Type

// ---------------------------------------------------------------------------
// The reference graph
// ---------------------------------------------------------------------------

/** How one block came to depend on another. */
export const EdgeSource = Schema.Union([
  Schema.TaggedStruct("Prop", { prop: Schema.String, capability: Capability }),
  /**
   * `{{ .outputs.<id>.<key> }}` in a prop or a template file: the
   * extractor's `OutputReference`.
   * `guarded`: behind a `hasKey` guard for the key, so the target must have
   * run but the key may be absent. A key is required if any edge to it is not.
   */
  Schema.TaggedStruct("Output", { key: Schema.String, guarded: Schema.Boolean }),
])
export type EdgeSource = typeof EdgeSource.Type

/**
 * One reference between two blocks, each named by its index in
 * `RunbookDocument.blocks`, as the tree's `block` nodes are. A display
 * block written without an id can still read forms through `inputsId`.
 */
export const Edge = Schema.Struct({
  /** The block that reads. */
  from: Schema.Int,
  /** The block it reads from. */
  to: Schema.Int,
  source: EdgeSource,
  /** Where the reference is written. */
  file: Schema.String,
  span: Span,
})
export type Edge = typeof Edge.Type

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/** One block as written, with its props decoded. */
export const BlockNode = Schema.Struct({
  /** Index in `RunbookDocument.blocks`; the tree's `block` nodes point here. */
  index: Schema.Int,
  /** The tag as written. An alias's tag differs from `block`. */
  tag: Schema.String,
  /** The registry block the tag resolves to. */
  block: Schema.String,
  class: BlockClass,
  /** Absent only for a display block written without one. */
  id: Schema.optionalKey(BlockId),
  /** The id as the author wrote it, for messages. */
  idAsWritten: Schema.optionalKey(Schema.String),
  /**
   * Decoded with the block's own schema, alias locks applied. Typed through
   * the registry. Undefined when they don't decode, which `errors` says.
   */
  props: Schema.Unknown,
  shared: SharedProps,
  /**
   * The inputs its run is given that its templates read
   * (`{{ .inputs.<path> }}`), each once, in the order written: a field's
   * name, or a map field's name and key (`tags.env`). They come from its own
   * props and `env`, not from a script (`ScriptSource`) and not from a
   * `title` or `description`, which are shown, not given to the run.
   */
  inputs: Schema.Array(Schema.String),
  span: Span,
  /**
   * The configuration errors in this block, in file order, each with a code
   * from `BlockErrorCode`. A block with any is `Misconfigured` and never runs.
   */
  errors: Schema.Array(ConfigError),
})
export type BlockNode = typeof BlockNode.Type

/**
 * A markdown node: mdast, as JSON. A registered block appears in the tree as
 * `{ type: "block", index, children }`; its children are its markdown
 * children, for a block that takes them.
 */
export interface TreeNode {
  readonly type: string
  readonly children?: ReadonlyArray<TreeNode>
  readonly [field: string]: unknown
}
export const TreeNode: Schema.Codec<TreeNode> = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    children: Schema.optionalKey(
      Schema.Array(Schema.suspend((): Schema.Codec<TreeNode> => TreeNode)),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

/** The `runbooks:` front matter and anything else the author put there. */
export const FrontMatter = Schema.Struct({
  /** A version range the app must satisfy: ">= 0.31". */
  runbooks: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
})
export type FrontMatter = typeof FrontMatter.Type

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export const RunbookDocument = Schema.Struct({
  /** The runbook file. */
  file: Schema.String,
  frontMatter: FrontMatter,
  /** The mdast root, blocks replaced by `block` nodes. */
  tree: TreeNode,
  /** Every block, in document order. */
  blocks: Schema.Array(BlockNode),
  edges: Schema.Array(Edge),
  hash: DocumentHash,
  warnings: Schema.Array(ConfigWarning),
})
export type RunbookDocument = typeof RunbookDocument.Type

/**
 * What parsing returns. A runbook with an error whose code is in
 * `RunbookErrorCode` is `Invalid`, and nothing opens; `errors` then holds
 * every error found, block errors included. Otherwise it is `Parsed`, and
 * each block's errors are on its node.
 */
export type ParseResult =
  | {
      readonly _tag: "Parsed"
      readonly document: RunbookDocument
      /**
       * The text of the files each block names, by the block's index, as the
       * document hashed them. A block's `fields` gets its own, so nothing
       * reads a file again.
       */
      readonly texts: ReadonlyMap<number, RunbookTexts>
    }
  | {
      readonly _tag: "Invalid"
      readonly errors: readonly [ConfigError, ...ReadonlyArray<ConfigError>]
      readonly warnings: ReadonlyArray<ConfigWarning>
    }

/** Every configuration error a parse found, in file order: the runbook's, or each block's. */
export function configErrors(result: ParseResult): ReadonlyArray<ConfigError> {
  if (result._tag === "Invalid") return result.errors
  const { document } = result
  return document.blocks.flatMap((node) => node.errors).sort(byPlace(document.file))
}
