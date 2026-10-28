import { useRef, useState } from "react"
import type React from "react"

/** CSS variable the pane's dragged width is set in, for the pane's own classes to use */
const WIDTH_VAR = "--pane-width"

/** How far each arrow key moves the handle, in pixels */
const KEYBOARD_STEPS: Partial<Record<string, number>> = { ArrowLeft: -16, ArrowRight: 16 }

interface UseResizableSplitOptions {
  /** localStorage key the dragged width persists under */
  storageKey: string
  /** Narrowest the pane can be made, in pixels */
  minWidth: number
  /** Width the pane must leave the rest of the container, handle included, in pixels */
  reservedWidth: number
}

interface UseResizableSplitReturn {
  /** Width the pane was dragged to, or null while it keeps the layout's own width */
  width: number | null
  /** Whether a drag is in progress */
  isResizing: boolean
  /** Ref to attach to the container the pane and the rest of it split */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** Ref to attach to the resizable pane */
  paneRef: React.RefObject<HTMLDivElement | null>
  /** Style for the pane, which sets `--pane-width` once the pane has been dragged */
  paneStyle: React.CSSProperties | undefined
  /** Handlers for the resize handle */
  handleProps: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void
    onPointerUp: () => void
    onPointerCancel: () => void
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void
    onDoubleClick: () => void
  }
}

function readStoredWidth(storageKey: string, minWidth: number): number | null {
  try {
    const stored = Number(localStorage.getItem(storageKey))
    return stored > 0 ? Math.max(stored, minWidth) : null
  } catch {
    /* localStorage unavailable (e.g. private mode) */
    return null
  }
}

/**
 * Hook for a pane whose width the handle beside it drags, as the runbook's
 * beside the generated files. Unlike `useResizablePanel`, the pane keeps the
 * layout's own width until it is first dragged, the dragged width persists
 * to localStorage, double-clicking the handle restores the layout's width,
 * and the arrow keys move a focused handle.
 *
 * The dragged width is set in `--pane-width` (via `paneStyle`), so the
 * pane's classes decide where it applies, e.g. `lg:w-(--pane-width)`.
 * Dragging sets the variable directly for smooth performance, then syncs
 * state when the drag ends.
 */
export function useResizableSplit({
  storageKey,
  minWidth,
  reservedWidth,
}: UseResizableSplitOptions): UseResizableSplitReturn {
  const [width, setWidth] = useState(() => readStoredWidth(storageKey, minWidth))
  const [isResizing, setIsResizing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    startX: number
    startWidth: number
    /** Width before the drag, which a drag that never moves goes back to */
    prevWidth: number | null
    maxWidth: number
    /** Width dragged to, or null until the pointer moves */
    width: number | null
  } | null>(null)

  // The pane's width as laid out, which the window may have narrowed below
  // the dragged width, and the widest the container leaves room for.
  const measure = () => {
    const pane = paneRef.current
    const container = containerRef.current
    if (!pane || !container) return null
    return {
      width: pane.getBoundingClientRect().width,
      maxWidth: container.clientWidth - reservedWidth,
    }
  }

  const clamp = (next: number, maxWidth: number) =>
    Math.round(Math.min(Math.max(next, minWidth), Math.max(maxWidth, minWidth)))

  const commit = (next: number | null) => {
    setWidth(next)
    try {
      if (next === null) localStorage.removeItem(storageKey)
      else localStorage.setItem(storageKey, String(next))
    } catch {
      /* localStorage unavailable — the width won't persist across launches */
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    const measured = measure()
    if (!measured) return
    e.preventDefault()
    // Moves keep coming to the handle while the pointer is over the panes
    // or outside the window.
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      startX: e.clientX,
      startWidth: measured.width,
      prevWidth: width,
      maxWidth: measured.maxWidth,
      width: null,
    }
    // Take over the pane's width where the layout had it, so the drag
    // starts from where the handle is.
    setWidth(measured.width)
    setIsResizing(true)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || (drag.width === null && e.clientX === drag.startX)) return
    drag.width = clamp(drag.startWidth + e.clientX - drag.startX, drag.maxWidth)
    paneRef.current?.style.setProperty(WIDTH_VAR, `${drag.width}px`)
  }

  const endDrag = () => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    setIsResizing(false)
    // A click, including each of a double-click's, leaves the width as it was.
    if (drag.width === null) setWidth(drag.prevWidth)
    else commit(drag.width)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const step = KEYBOARD_STEPS[e.key]
    if (step === undefined) return
    const measured = measure()
    if (!measured) return
    e.preventDefault()
    commit(clamp(measured.width + step, measured.maxWidth))
  }

  return {
    width,
    isResizing,
    containerRef,
    paneRef,
    paneStyle: width === null ? undefined : ({ [WIDTH_VAR]: `${width}px` } as React.CSSProperties),
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onKeyDown,
      onDoubleClick: () => commit(null),
    },
  }
}
