/**
 * An open runbook: its title, the warnings the engine found in it, and its
 * markdown, walked (`markdown.tsx`).
 *
 * The markdown sits in the body's box, which has `contain: paint`: nothing
 * the author styles inside it paints or takes a click outside it, not even
 * an element with `position: fixed` and a high z-index, since the box is the
 * containing block of its fixed elements and a stacking context of its own.
 * The app's header, the title, the warnings, and the trust prompt (row 3i)
 * stay outside it. The containment is a style prop, set through the CSSOM,
 * so it holds whether or not the stylesheet loads.
 */
import type { DocumentView, SessionSummary } from "@runbooks/core/protocol"
import { useEnded } from "./following.ts"
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
  const ended = useEnded()
  return (
    <article className="runbook">
      <h1>{document.title ?? session.name}</h1>
      {ended === undefined ? null : <p className="ended">{ended}</p>}
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
      <div className="runbook-body" style={{ contain: "paint" }}>
        <Markdown document={document} runbook={session.path} session={session.session} />
      </div>
    </article>
  )
}
