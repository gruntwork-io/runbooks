import { useEffect, useEffectEvent } from "react"
import type { FilesScroll } from "@/lib/fileReview"

/**
 * How long after a wheel, touch or key the element's scrolls count as the
 * user's: long enough for smooth scrolling by key. A trackpad's momentum
 * keeps sending wheel events.
 */
export const USER_SCROLL_WINDOW_MS = 500

const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "])

/** Whether a key scrolls rather than types or presses a button. */
function scrollsByKey(event: KeyboardEvent): boolean {
  if (!SCROLL_KEYS.has(event.key)) return false
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) {
    return false
  }
  return event.key !== " " || !target?.closest("button, a[href], [role=button], [role=treeitem]")
}

/**
 * Calls `onScroll` with each scroll of `element` the user makes: with the
 * wheel or a trackpad, by touch, with the keys or by dragging its scrollbar.
 * Scrolls that code makes, such as scrollIntoView, and the ones layout changes
 * make are left out: a click elsewhere, or a key that doesn't scroll, ends the
 * user's scrolling.
 */
export function useUserScrolls(
  element: HTMLElement | null,
  onScroll: (scroll: FilesScroll) => void,
): void {
  const report = useEffectEvent(onScroll)

  useEffect(() => {
    if (!element) return
    let last = element.scrollTop
    let userUntil = 0
    let draggingScrollbar = false

    const byUser = () => {
      userUntil = performance.now() + USER_SCROLL_WINDOW_MS
    }
    const notByUser = () => {
      userUntil = 0
      draggingScrollbar = false
    }
    const onKeyDown = (event: KeyboardEvent) => (scrollsByKey(event) ? byUser() : notByUser())
    // A press on the element itself, not on what it holds, is on its scrollbar.
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === element) draggingScrollbar = true
      else notByUser()
    }
    const onPointerUp = () => {
      if (!draggingScrollbar) return
      draggingScrollbar = false
      byUser()
    }
    const onScrollEvent = () => {
      const from = last
      last = element.scrollTop
      if (!draggingScrollbar && performance.now() > userUntil) return
      report({ from, to: last })
    }

    const options = { capture: true, passive: true }
    element.addEventListener("wheel", byUser, options)
    element.addEventListener("touchmove", byUser, options)
    element.addEventListener("scroll", onScrollEvent, options)
    window.addEventListener("keydown", onKeyDown, options)
    window.addEventListener("pointerdown", onPointerDown, options)
    window.addEventListener("pointerup", onPointerUp, options)
    return () => {
      element.removeEventListener("wheel", byUser, options)
      element.removeEventListener("touchmove", byUser, options)
      element.removeEventListener("scroll", onScrollEvent, options)
      window.removeEventListener("keydown", onKeyDown, options)
      window.removeEventListener("pointerdown", onPointerDown, options)
      window.removeEventListener("pointerup", onPointerUp, options)
    }
  }, [element])
}
