/**
 * An open runbook: its title, the warnings the engine found in it, and its
 * markdown, walked (`markdown.tsx`), as the session holds it now: the page
 * redraws when the session reloads it (`live.ts`).
 *
 * The markdown sits in the body's box, which has `contain: paint`: nothing
 * the author styles inside it paints or takes a click outside it, not even
 * an element with `position: fixed` and a high z-index, since the box is the
 * containing block of its fixed elements and a stacking context of its own.
 * The app's header, the title, the warnings, the instruction mode banner
 * and the trust prompt (`trustPrompt.tsx`) stay outside it, so the author
 * can't cover or imitate them. The containment is a style prop, set
 * through the CSSOM, so it holds whether or not the stylesheet loads.
 */
import type { DocumentView, SessionSummary } from "@runbooks/core/protocol"
import { useDocument, useEnded, useInstructionMode } from "./following.ts"
import { Markdown, unknownParts } from "./markdown.tsx"
import { place } from "./place.ts"
import { TrustPrompt } from "./trustPrompt.tsx"

export function Runbook({
  session,
  document: opened,
}: {
  readonly session: SessionSummary
  /** The runbook as the window opened it, which it draws until it has read the session. */
  readonly document: DocumentView
}) {
  const document = useDocument() ?? opened
  const unknown = [...unknownParts(document.tree)]
  const hidden = unknown.reduce((total, [, count]) => total + count, 0)
  const ended = useEnded()
  const instructionMode = useInstructionMode()
  return (
    <article className="runbook">
      <h1>{document.title ?? session.name}</h1>
      {ended === undefined ? null : <p className="ended">{ended}</p>}
      {instructionMode ? (
        // The old app's banner, its dash a colon.
        <p className="instruction-mode">
          Instruction mode: nothing here runs automatically. Each step shows the exact command to
          copy and run yourself.
        </p>
      ) : null}
      <TrustPrompt document={document} />
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
