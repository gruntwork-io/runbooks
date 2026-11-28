/**
 * The view map: MDX tag to the React component that draws a block. A block's
 * View.tsx exports its entry, `view`, under its tag, which this file imports
 * and spreads into the map: one import per view. Only the app loads it. Its
 * type comes from the registry: a view for a tag the registry lacks, or with
 * the wrong props, fails the build, and so does a display block with no
 * view, since that class has no default. Form, task and credential blocks
 * without one get their class's view.
 *
 * The engine sends a block's props as JSON (`DocumentBlock.props`), so the map
 * the frame draws from gives each view its props decoded with its block's
 * own schema (`viewsFromJson`).
 */
import { type ComponentType, createElement, type ReactNode } from "react"
import { Option, Schema } from "effect"
import type { Rpc } from "effect/rpc"
import {
  type BlockTags,
  type PropsOf,
  type Registry,
  isAlias,
  type TagsOfClass,
} from "@runbooks/blocks-core/registry"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import type {
  ActOnCredential,
  CancelBlock,
  ResetBlock,
  RunBlock,
  SetValues,
} from "@runbooks/core/protocol"
import * as registry from "./index.ts"

type ViewRpc =
  | typeof RunBlock
  | typeof CancelBlock
  | typeof ResetBlock
  | typeof SetValues
  | typeof ActOnCredential

/** What a view may ask the engine for. The frame adds the session and the block. */
export type ViewRequest = ViewRpc extends infer R
  ? R extends ViewRpc
    ? { readonly _tag: Rpc.Tag<R> } & Omit<Rpc.Payload<R>, "session" | "block">
    : never
  : never

export interface ViewProps<P> {
  readonly props: P
  /** Absent for a display block, which has no lifecycle. */
  readonly status: BlockStatus | undefined
  readonly act: (request: ViewRequest) => void
  /** The block's markdown children, rendered. */
  readonly children?: ReactNode
}

export type View<P> = ComponentType<ViewProps<P>>

/** The views a registry needs: one for each display block, and any others. */
export type ViewsFor<R extends Registry> = {
  readonly [T in TagsOfClass<R, "display">]: View<PropsOf<R[T]>>
} & {
  readonly [T in Exclude<BlockTags<R>, TagsOfClass<R, "display">>]?: View<PropsOf<R[T]>>
}

/** A view the frame draws with the JSON the engine sends. */
type JsonView = View<Schema.Json>

/**
 * `Own` drawing from JSON props, decoded with `schema`. The engine encoded
 * them with the same schema, so they decode; props that do not would be a
 * bug in the block, so it draws a line that says so in the block's place.
 */
function fromJson<P>(tag: string, schema: Schema.Codec<P, unknown>, Own: View<P>): JsonView {
  const decode = Schema.decodeUnknownOption(schema)
  return function Decoded({ props, ...rest }: ViewProps<Schema.Json>) {
    return Option.match(decode(props), {
      onNone: () =>
        createElement(
          "p",
          { className: "block-no-view" },
          `The window can't read the props of <${tag}>.`,
        ),
      onSome: (decoded) => createElement(Own, { ...rest, props: decoded }),
    })
  }
}

/**
 * The map the frame draws from: each of `own`'s views behind its block's
 * decode, by tag. The frame looks a view up by its block's name, which an
 * alias's block has too, so only a tag that names a block keeps its view,
 * as `ViewsFor` has no slot for an alias.
 */
export function viewsFromJson<R extends Registry>(
  blocks: R,
  own: ViewsFor<R>,
): Readonly<Partial<Record<string, JsonView>>> {
  return Object.fromEntries(
    Object.entries<View<any>>(own).flatMap(([tag, Own]) => {
      const entry = Object.hasOwn(blocks, tag) ? blocks[tag] : undefined
      return entry === undefined || isAlias(entry) ? [] : [[tag, fromJson(tag, entry.props, Own)]]
    }),
  )
}

export const views = viewsFromJson(registry, {})
