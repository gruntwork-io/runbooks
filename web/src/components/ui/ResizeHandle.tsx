import type React from 'react'

interface ResizeHandleProps {
  /** onMouseDown handler from useResizablePanel */
  onMouseDown: (e: React.MouseEvent) => void
}

/**
 * Vertical resize handle — 7px hit area with a 1px visible line.
 * Users can drag this to resize the panel.
 * Pair with the `useResizablePanel` hook.
 */
export function ResizeHandle({ onMouseDown }: ResizeHandleProps) {
  return (
    <div
      className="w-[7px] cursor-col-resize flex-shrink-0 flex items-stretch justify-center group"
      onMouseDown={onMouseDown}
    >
      <div className="w-px bg-border group-hover:bg-primary group-hover:shadow-[0_0_0_2px_rgba(59,130,246,0.5)] transition-all" />
    </div>
  )
}
