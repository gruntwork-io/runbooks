/**
 * A block's place in the walk, until `BlockFrame` and the default views
 * (row 3h): its tag, its id and title if it has them, its description, and
 * its markdown children inside it.
 */
import type { ReactNode } from "react"
import type { DocumentBlock } from "@runbooks/core/protocol"

export function BlockPlaceholder({
  block,
  children,
}: {
  readonly block: DocumentBlock
  readonly children: ReactNode
}) {
  return (
    <section className="block" aria-label={`<${block.tag}> block`}>
      <header className="block-header">
        <code className="block-tag">{`<${block.tag}>`}</code>
        {block.id === undefined ? null : <span className="block-id">{block.id}</span>}
        {block.title === undefined ? null : <span className="block-title">{block.title}</span>}
      </header>
      {block.description === undefined ? null : (
        <p className="block-description">{block.description}</p>
      )}
      <div className="block-body">{children}</div>
    </section>
  )
}
