/**
 * A link to a block's frame, as the old app's `BlockLink` is: the frame's
 * element id, a scroll that brings the frame to the middle of the window,
 * and the link itself, which the frame's "Waiting for:" list and the
 * page's notes draw.
 */

/** The element id of a block's frame, which a link to the block scrolls to. */
export const frameId = (block: string): string => `runbook-block-${block}`

/** Scrolls the frame of `block` to the middle of the window, as the old app's `BlockLink` does. */
export function scrollToBlock(
  document: {
    readonly getElementById: (
      id: string,
    ) => { readonly scrollIntoView: (options: ScrollIntoViewOptions) => void } | null
  },
  block: string,
) {
  document.getElementById(frameId(block))?.scrollIntoView({ behavior: "smooth", block: "center" })
}

/** A block's id: a link that scrolls to its frame, or its text when the page draws none. */
export function BlockLink({
  block,
  onPage,
}: {
  readonly block: string
  readonly onPage: ReadonlySet<string>
}) {
  if (!onPage.has(block)) return <code className="block-link">{block}</code>
  return (
    <a
      href={`#${frameId(block)}`}
      className="block-link"
      onClick={(event) => {
        event.preventDefault()
        scrollToBlock(event.currentTarget.ownerDocument, block)
      }}
    >
      {block}
    </a>
  )
}
