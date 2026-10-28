import type React from "react"
import { cn } from "@/lib/utils"

interface ResizeHandleProps extends React.ComponentProps<"div"> {
  /** Show the line only while the handle is hovered or focused, for a handle that fills a gap */
  subtle?: boolean | undefined
}

/**
 * Vertical resize handle — 7px hit area with a 1px visible line.
 * Users can drag this to resize the panel.
 * Pair with the `useResizablePanel` or `useResizableSplit` hook.
 */
export function ResizeHandle({ className, subtle = false, ...props }: ResizeHandleProps) {
  return (
    <div
      className={cn(
        "w-[7px] cursor-col-resize flex-shrink-0 flex items-stretch justify-center group outline-none",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "w-px group-hover:bg-primary group-hover:ring-2 group-hover:ring-primary/40 transition-all",
          subtle
            ? "group-focus-visible:bg-primary group-focus-visible:ring-2 group-focus-visible:ring-primary/40"
            : "bg-border",
        )}
      />
    </div>
  )
}
