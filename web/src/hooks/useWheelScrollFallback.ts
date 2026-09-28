import { useCallback } from 'react'
import type { RefObject, WheelEvent } from 'react'

/**
 * Returns an `onWheel` handler that scrolls `targetRef` when a wheel gesture
 * lands on a part of the page that does not scroll on its own.
 *
 * A gesture that starts inside an element that scrolls on its own, such as
 * the artifacts panel or an open dropdown, is left to the browser.
 */
export function useWheelScrollFallback(targetRef: RefObject<HTMLElement | null>) {
  return useCallback(
    (event: WheelEvent<HTMLElement>) => {
      const target = targetRef.current
      if (!target || event.deltaY === 0) return
      if (hasScrollableAncestor(event.target, event.currentTarget)) return
      target.scrollBy({ top: event.deltaY })
    },
    [targetRef],
  )
}

function hasScrollableAncestor(start: EventTarget | null, boundary: HTMLElement): boolean {
  let element = start instanceof Element ? start : null
  while (element && element !== boundary) {
    if (scrollsVertically(element)) return true
    element = element.parentElement
  }
  return false
}

function scrollsVertically(element: Element): boolean {
  const { overflowY } = getComputedStyle(element)
  return (overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight
}
