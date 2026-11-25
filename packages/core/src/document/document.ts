/**
 * A runbook, parsed once in the core into data. Nothing in it is ever
 * evaluated: the renderer walks `tree`, and the engine reads `blocks` and
 * `edges`. Every client gets the same document.
 */
import { Schema } from "effect"
import { BlockClass, BlockId, Capability, RunbookPath } from "@runbooks/blocks-core/contract"
import { ConfigError, ConfigWarning, Span } from "./configError.ts"

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
// Shared props
// ---------------------------------------------------------------------------

/**
 * The props the host owns for every block of a class, decoded by the parser
 * so no block repeats them. Which apply depends on the class and on the
 * block's effects; one that does not apply is an `unknownProp` warning.
 */
export const SharedProps = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  /** Fold the block to its header once it is done. */
  autoCollapse: Schema.optionalKey(Schema.Boolean),
  /** Any block: the forms whose values it reads (capability `values`). A display block reads them into its text. */
  inputsId: Schema.optionalKey(Schema.Array(BlockId)),
  /** Task: blocks that must be done first (capability `run`). */
  dependsOn: Schema.optionalKey(Schema.Array(BlockId)),
  /** Task with the `process` effect: environment sources, in order, later winning (capability `env`). */
  envFrom: Schema.optionalKey(Schema.Array(BlockId)),
  /** Task with the `process` effect: variables set last, before the reserved `RUNBOOK_*` ones. Values may hold template references. */
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})
export type SharedProps = typeof SharedProps.Type

// ---------------------------------------------------------------------------
// The reference graph
// ---------------------------------------------------------------------------

/** How one block came to depend on another. */
export const EdgeSource = Schema.Union([
  Schema.TaggedStruct("Prop", { prop: Schema.String, capability: Capability }),
  /**
   * `{{ .outputs.<id>.<key> }}` in a prop, a script or a template file.
   * `guarded`: behind a `hasKey` guard for the key, so the target must have
   * run but the key may be absent. A key is required if any edge to it is not.
   */
  Schema.TaggedStruct("Template", { key: Schema.String, guarded: Schema.Boolean }),
])
export type EdgeSource = typeof EdgeSource.Type

export const Edge = Schema.Struct({
  /** The block that reads. */
  from: BlockId,
  /** The block it reads from. */
  to: BlockId,
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
  /** Decoded with the block's own schema, alias locks applied. Typed through the registry. */
  props: Schema.Unknown,
  shared: SharedProps,
  span: Span,
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
 * What parsing returns. Errors are all reported in one pass; a runbook with
 * any error does not load, so the engine only ever holds a `Parsed` document.
 */
export type ParseResult =
  | { readonly _tag: "Parsed"; readonly document: RunbookDocument }
  | {
      readonly _tag: "Invalid"
      readonly errors: readonly [ConfigError, ...ReadonlyArray<ConfigError>]
      readonly warnings: ReadonlyArray<ConfigWarning>
    }
