import { createContext, useContext, useState } from "react"
import type { Dispatch, ReactNode, SetStateAction } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"
import "./AutoCollapse.css"

/** Whether the block it's in is folded. Null unless the block could fold. */
const FoldedContext = createContext<boolean | null>(null)
/** Sets whether the block it's in is expanded. */
const SetExpandedContext = createContext<Dispatch<SetStateAction<boolean>> | null>(null)

interface AutoCollapseProps {
  /** The block's `autoCollapse` prop. */
  enabled: boolean | undefined
  /** Whether the block is done: the state its progress step reports. */
  done: boolean
  children: ReactNode
}

/**
 * Folds a done block with `autoCollapse` down to its header, which expands it
 * again when clicked. It folds each time the block becomes done, and a block
 * that is done when it mounts (a resumed session) starts folded. While it
 * isn't done it never folds, so a block that is no longer done, such as a
 * sign-in that expired, shows in full.
 *
 * The block marks its header with `data-fold` (see AutoCollapse.css), and
 * folding hides everything else in it, so the header stays where it was. The
 * block stays mounted, so its form values, logs and progress step stay as
 * they were.
 */
export function AutoCollapse({ enabled, done, children }: AutoCollapseProps) {
  const collapsible = !!enabled && done
  const [expanded, setExpanded] = useState(false)
  const [wasCollapsible, setWasCollapsible] = useState(collapsible)
  if (collapsible !== wasCollapsible) {
    setWasCollapsible(collapsible)
    if (collapsible) setExpanded(false)
  }
  const folded = collapsible && !expanded

  return (
    <FoldedContext.Provider value={collapsible ? folded : null}>
      <SetExpandedContext.Provider value={setExpanded}>
        {/* A click anywhere on a folded block expands it */}
        <div
          data-folded={folded || undefined}
          className={folded ? "contents block-folded cursor-pointer" : "contents"}
          onClick={folded ? () => setExpanded(true) : undefined}
        >
          {children}
        </div>
      </SetExpandedContext.Provider>
    </FoldedContext.Provider>
  )
}

/** Shows its children only while the block it's in is folded. */
export function WhenFolded({ children }: { children: ReactNode }) {
  return useContext(FoldedContext) === true ? children : null
}

/**
 * Expands the folded block it's in, or folds it again. Blocks render it beside
 * their ID label; it shows only while the block could fold.
 */
export function CollapseButton() {
  const folded = useContext(FoldedContext)
  const setExpanded = useContext(SetExpandedContext)
  if (folded === null || !setExpanded) return null

  return (
    <button
      type="button"
      aria-expanded={!folded}
      aria-label={folded ? "Expand block" : "Collapse block"}
      onClick={() => setExpanded((expanded) => !expanded)}
      className="rounded p-0.5 text-muted-foreground cursor-pointer outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {folded ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
    </button>
  )
}
