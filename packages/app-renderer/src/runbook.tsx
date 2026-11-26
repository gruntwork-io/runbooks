/**
 * An open runbook: its title, the warnings the engine found in it, and its
 * markdown, walked (`markdown.tsx`).
 */
import type { DocumentView, SessionSummary } from "@runbooks/core/protocol"
import { Markdown, unknownParts } from "./markdown.tsx"
import { place } from "./place.ts"

export function Runbook({
  session,
  document,
}: {
  readonly session: SessionSummary
  readonly document: DocumentView
}) {
  const unknown = [...unknownParts(document.tree)]
  const hidden = unknown.reduce((total, [, count]) => total + count, 0)
  return (
    <article className="runbook">
      <h1>{document.title ?? session.name}</h1>
      {document.warnings.length === 0 ? null : (
        <ul className="warnings" aria-label="Warnings">
          {document.warnings.map((warning, index) => (
            <li key={index}>{`${place(warning.location, session.path)}: ${warning.message}`}</li>
          ))}
        </ul>
      )}
      {hidden === 0 ? null : (
        <p className="unknown-parts">
          {`This window can't show ${hidden === 1 ? "1 part" : `${hidden} parts`} of the runbook yet, so it shows their text: ${unknown.map(([label, count]) => `${label} (${count})`).join(", ")}.`}
        </p>
      )}
      <div className="runbook-body">
        <Markdown document={document} runbook={session.path} />
      </div>
    </article>
  )
}
