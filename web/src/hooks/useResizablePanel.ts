import { useState, useCallback, useRef, useEffect } from 'react'
import type React from 'react'

interface UseResizablePanelOptions {
  /** Initial width in pixels (default: 225) */
  initialWidth?: number
  /** Minimum width in pixels (default: 150) */
  minWidth?: number
  /** Maximum width in pixels (default: 400) */
  maxWidth?: number
}

interface UseResizablePanelReturn {
  /** Current width of the resizable panel */
  treeWidth: number
  /** Whether a resize drag is in progress */
  isResizing: boolean
  /** Ref to attach to the outer container */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** Ref to attach to the resizable panel */
  treeRef: React.RefObject<HTMLDivElement | null>
  /** onMouseDown handler for the resize handle */
  handleMouseDown: (e: React.MouseEvent) => void
}

/**
 * Hook for managing a resizable panel with drag-to-resize behavior.
 * Updates the DOM directly during drag for smooth performance,
 * then syncs state on mouse-up.
 */
export function useResizablePanel({
  initialWidth = 225,
  minWidth = 150,
  maxWidth = 400,
}: UseResizablePanelOptions = {}): UseResizablePanelReturn {
  const [treeWidth, setTreeWidth] = useState(initialWidth)
  const [isResizing, setIsResizing] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLDivElement>(null)
  const widthRef = useRef(initialWidth)
  const rafRef = useRef<number | null>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    widthRef.current = treeWidth
    setIsResizing(true)
  }, [treeWidth])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }

      rafRef.current = requestAnimationFrame(() => {
        if (!containerRef.current || !treeRef.current) return
        const containerRect = containerRef.current.getBoundingClientRect()
        const newWidth = Math.min(Math.max(e.clientX - containerRect.left, minWidth), maxWidth)
        treeRef.current.style.width = `${newWidth}px`
        widthRef.current = newWidth
      })
    }

    const handleMouseUp = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      setTreeWidth(widthRef.current)
      setIsResizing(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [isResizing, minWidth, maxWidth])

  return { treeWidth, isResizing, containerRef, treeRef, handleMouseDown }
}
