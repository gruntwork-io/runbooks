/** How long a block that changes size as it renders keeps its top in view. */
const SETTLE_MS = 1000

/** Events that mean the user is scrolling and the page should follow them, not the block. */
const USER_SCROLLS = ["wheel", "touchmove", "keydown", "pointerdown"] as const

/** The nearest ancestor that scrolls, or the document's scroller. */
function scrollerOf(element: HTMLElement): HTMLElement {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node
    }
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement
}

/**
 * Scrolls smoothly until `element`'s top is at the top of its scroller, and
 * keeps it there while the element resizes as new content renders, until the
 * user scrolls or the content has had time to settle.
 */
export function scrollToTop(element: HTMLElement): void {
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  const scroll = () =>
    element.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "start" })
  scroll()
  if (typeof ResizeObserver === "undefined") return

  // Scroll anchoring would hold content below the block in place as the block grows, pushing its top away.
  const scroller = scrollerOf(element)
  const anchoring = scroller.style.overflowAnchor
  scroller.style.overflowAnchor = "none"
  const observer = new ResizeObserver(scroll)
  const stop = () => {
    scroller.style.overflowAnchor = anchoring
    observer.disconnect()
    clearTimeout(timer)
    for (const type of USER_SCROLLS) window.removeEventListener(type, stop, { capture: true })
  }
  const timer = setTimeout(stop, SETTLE_MS)
  observer.observe(element)
  for (const type of USER_SCROLLS) {
    window.addEventListener(type, stop, { capture: true, passive: true, once: true })
  }
}
