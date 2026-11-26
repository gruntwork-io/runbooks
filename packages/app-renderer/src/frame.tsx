/**
 * `BlockFrame`: the one frame the walk draws every block in. It draws what
 * the block's class decides, and no block's view draws any of it:
 *
 * - the header: the progress step mark, the tag, the id and the title, and
 *   the description under it;
 * - a misconfigured block's errors, each with its line, in place of its
 *   view;
 * - the body: the class's default view.
 *
 * Classes are a closed set: each switch over one names every class, so a
 * fifth fails the build here.
 */
import type { ReactNode } from "react"
import type { DocumentBlock } from "@runbooks/core/protocol"
import { place } from "./place.ts"

type Configured = Extract<DocumentBlock, { readonly _tag: "Configured" }>

/** The element id of a block's frame, which a link to the block scrolls to. */
const frameId = (block: string): string => `runbook-block-${block}`

export function BlockFrame({
  block,
  runbook,
  children,
}: {
  readonly block: DocumentBlock
  /** The runbook file, which the block's errors are located in. */
  readonly runbook: string
  /** The block's markdown children, rendered. */
  readonly children: ReactNode
}) {
  return (
    <section
      className="block"
      aria-label={`<${block.tag}> block`}
      id={block.id === undefined ? undefined : frameId(block.id)}
    >
      <header className="block-header">
        {block._tag === "Configured" && block.step ? <StepMark done={false} /> : null}
        <code className="block-tag">{`<${block.tag}>`}</code>
        {block.id === undefined ? null : <span className="block-id">{block.id}</span>}
        {block.title === undefined ? null : <span className="block-title">{block.title}</span>}
      </header>
      {block.description === undefined ? null : (
        <p className="block-description">{block.description}</p>
      )}
      {block._tag === "Misconfigured" ? (
        <ul className="block-errors" aria-label="Configuration errors">
          {block.errors.map((error, index) => (
            <li key={index}>{`${place(error.location, runbook)}: ${error.message}`}</li>
          ))}
        </ul>
      ) : (
        <Body block={block}>{children}</Body>
      )}
    </section>
  )
}

/** Whether a progress step is done, as a mark at the head of its frame. */
function StepMark({ done }: { readonly done: boolean }) {
  return (
    <span
      className="block-step"
      role="img"
      aria-label={done ? "Step: done" : "Step: not done"}
      data-done={done}
    >
      {done ? "✓" : "○"}
    </span>
  )
}

/** The class's default view. Form and credential blocks get theirs with their first blocks. */
function Body({ block, children }: { readonly block: Configured; readonly children: ReactNode }) {
  switch (block.class) {
    case "display":
    case "task":
      return <div className="block-body">{children}</div>
    case "form":
      return <NoView line="The window can't show this form's fields yet.">{children}</NoView>
    case "credential":
      return <NoView line="The window can't show this sign-in yet.">{children}</NoView>
    default: {
      const unhandled: never = block.class
      throw new Error(`The frame has no body for the class ${String(unhandled)}.`)
    }
  }
}

/** A block whose class has no default view yet: its markdown, and a line that says so. */
function NoView({ line, children }: { readonly line: string; readonly children: ReactNode }) {
  return (
    <div className="block-body">
      {children}
      <p className="block-no-view">{line}</p>
    </div>
  )
}
