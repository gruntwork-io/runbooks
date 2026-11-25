/**
 * The view map: MDX tag to the React component that draws a block, one line
 * per view. Only the app loads it. Its type comes from the registry: a view
 * for a tag the registry lacks, or with the wrong props, fails the build, and
 * so does a display block with no view, since that class has no default.
 * Form, task and credential blocks without a line get their class's view.
 */
import type { ComponentType, ReactNode } from "react"
import type { Rpc } from "effect/rpc"
import type { BlockTags, PropsOf, Registry, TagsOfClass } from "@runbooks/blocks-core/registry"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import type {
  ActOnCredential,
  CancelBlock,
  ResetBlock,
  RunBlock,
  SetValues,
} from "@runbooks/core/protocol"
import type * as registry from "./index.ts"

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

export const views = {} satisfies ViewsFor<typeof registry>
