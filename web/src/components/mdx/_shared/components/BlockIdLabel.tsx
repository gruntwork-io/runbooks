import { useEffect, useRef, useState } from "react"
import { Copy, Check } from "lucide-react"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import { cn } from "@/lib/utils"

interface BlockIdLabelProps {
  id: string
  /** Size variant - 'small' for icon column, 'large' for top-right corner */
  size?: 'small' | 'large'
}

/**
 * How long the pointer must rest on the badge before it expands. In
 * instruction mode the pill grows leftward over the "Mark as done" button
 * beside the badge, so a pointer only passing over the badge on its way there
 * must not open it.
 */
const HOVER_INTENT_MS = 200

/**
 * A small "ID" badge for an MDX block. Resting the pointer on it (or focusing
 * it from the keyboard) expands it inline into `ID <block id> [copy]`, and
 * clicking anywhere on it copies the block ID.
 *
 * Callers pin it to the block's top-right corner, so it grows leftward over
 * the block without reflowing anything.
 */
export function BlockIdLabel({ id, size = 'small' }: BlockIdLabelProps) {
  const { didCopy, copy } = useCopyToClipboard(2000)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const expanded = hovered || focused
  const iconSize = size === 'large' ? 'size-3.5' : 'size-2.5'

  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  const cancelHoverTimer = () => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = undefined
  }

  const handleMouseEnter = () => {
    cancelHoverTimer()
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = undefined
      setHovered(true)
    }, HOVER_INTENT_MS)
  }

  const handleMouseLeave = () => {
    cancelHoverTimer()
    setHovered(false)
  }

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    // A click is deliberate: expand now rather than waiting out the hover
    // delay, so the check mark shows as soon as the copy lands.
    if (hoverTimer.current !== undefined) {
      cancelHoverTimer()
      setHovered(true)
    }
    await copy(id)
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      // Keep mouse clicks from focusing the badge: focus also expands it, so a
      // clicked badge would stay open over the block after the pointer left.
      // Keyboard focus (Tab) still works.
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      // The name stays fixed so name queries like /run/i never match an ID
      // such as "run-setup"; the description lets a screen reader read the ID.
      aria-label={didCopy ? 'Copied block ID' : 'Copy block ID'}
      aria-description={id}
      className={cn(
        'relative z-20 flex w-fit items-center gap-1.5 whitespace-nowrap rounded font-mono text-muted-foreground select-none cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        size === 'large' ? 'text-xs px-1.5 py-0.5' : 'text-[9px] mt-1',
        // Opaque while expanded: the pill grows leftward over the block header.
        expanded
          ? 'bg-popover shadow-sm ring-1 ring-border'
          : size === 'large' && 'bg-accent/50',
      )}
    >
      ID
      {expanded && (
        <>
          {/* Long IDs are cut short on screen; a click still copies all of it. */}
          <span className="min-w-0 max-w-96 truncate font-medium text-popover-foreground">{id}</span>
          {didCopy ? (
            <Check className={cn(iconSize, 'shrink-0 text-success')} />
          ) : (
            <Copy className={cn(iconSize, 'shrink-0')} />
          )}
        </>
      )}
    </button>
  )
}
