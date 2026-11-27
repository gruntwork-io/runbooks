/**
 * What the page says of the runbook on disk, above the runbook's box: that
 * the session stopped watching it (`SessionView.unwatched`), and why the
 * session holds back a reload of it (`SessionView.reloadHeld`):
 *
 * - the blocks the reload waits for, each linked to its frame as a
 *   block's waits are (`BlockLink`);
 * - the saved runbook's errors, each with its file and line, as a
 *   misconfigured block's are (`place`);
 * - why the saved runbook could not be read.
 *
 * Each shows as the session's events say, and the held reload goes when
 * one clears it. Neither shows once the window stopped following the
 * session, since nothing reloads then. The words are plain: the old app
 * held no reload back, and its watch-mode spec says nothing of either.
 */
import type { DocumentView, ReloadHeld } from "@runbooks/core/protocol"
import { BlockLink } from "./frame.tsx"
import { useEnded, useReloadHeld, useUnwatched } from "./following.ts"
import { framedIn } from "./markdown.tsx"
import { place } from "./place.ts"

export function WatchNotes({
  document,
  runbook,
}: {
  /** The runbook the page draws. */
  readonly document: DocumentView
  /** The runbook file, which the saved runbook's errors are located in. */
  readonly runbook: string
}) {
  const held = useReloadHeld()
  const unwatched = useUnwatched()
  const ended = useEnded()
  if (ended !== undefined) return null
  return (
    <>
      {unwatched === undefined ? null : <p className="unwatched">{unwatched.message}</p>}
      {held === undefined ? null : (
        <section className="reload-held" aria-label="Reload held back">
          <Held held={held} document={document} runbook={runbook} />
        </section>
      )}
    </>
  )
}

function Held({
  held,
  document,
  runbook,
}: {
  readonly held: ReloadHeld
  readonly document: DocumentView
  readonly runbook: string
}) {
  switch (held._tag) {
    case "Running": {
      const onPage = framedIn(document.tree, document.blocks)
      return (
        <>
          <p>This runbook changed on disk. It reloads once these blocks stop running:</p>
          <ul>
            {held.blocks.map((block) => (
              <li key={block}>
                <BlockLink block={block} onPage={onPage} />
              </li>
            ))}
          </ul>
        </>
      )
    }
    case "Invalid":
      return (
        <>
          <p>
            This runbook changed on disk, but the saved runbook has errors, so this is still the
            runbook as it was. It reloads once they are fixed:
          </p>
          <ul>
            {held.errors.map((error, index) => (
              <li key={index}>{`${place(error.location, runbook)}: ${error.message}`}</li>
            ))}
          </ul>
        </>
      )
    case "Unreadable":
      return (
        <p>{`This runbook changed on disk, but the saved runbook could not be read, so this is still the runbook as it was: ${held.message}`}</p>
      )
    default: {
      const unhandled: never = held
      throw new Error(`The page has no words for the held reload ${JSON.stringify(unhandled)}.`)
    }
  }
}
