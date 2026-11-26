/**
 * A block's place in the walk, until `BlockFrame` and the default views
 * (row 3h): its tag, its id and title if it has them, its description, and
 * its markdown children inside it. A misconfigured block shows its errors
 * in place of its children, each with its line.
 */
import type { ReactNode } from "react"
import type { DocumentBlock } from "@runbooks/core/protocol"

type Location = Extract<DocumentBlock, { _tag: "Misconfigured" }>["errors"][number]["location"]

/** Where an error is: its line, and its file when that is not the runbook, from the runbook's folder. */
function place({ file, span }: Location, runbook: string): string {
  const line = span.start.line
  if (file === runbook) return `Line ${line}`
  const folder = runbook.slice(0, Math.max(runbook.lastIndexOf("/"), runbook.lastIndexOf("\\")) + 1)
  return `${file.startsWith(folder) ? file.slice(folder.length) : file}, line ${line}`
}

export function BlockPlaceholder({
  block,
  runbook,
  children,
}: {
  readonly block: DocumentBlock
  /** The runbook file, which the block's errors are located in. */
  readonly runbook: string
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
      {block._tag === "Misconfigured" ? (
        <ul className="block-errors" aria-label="Configuration errors">
          {block.errors.map((error, index) => (
            <li key={index}>{`${place(error.location, runbook)}: ${error.message}`}</li>
          ))}
        </ul>
      ) : (
        <div className="block-body">{children}</div>
      )}
    </section>
  )
}
