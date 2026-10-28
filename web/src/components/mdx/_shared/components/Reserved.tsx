import type { ReactNode } from "react"

interface ReservedProps<K extends string> {
  /** What can show here, by name. */
  variants: Record<K, ReactNode>
  /** The variant that shows, or null for none. */
  shown: K | null
  className?: string | undefined
}

// Inline rather than Tailwind's `invisible`, so jsdom sees it too.
const HIDDEN = { visibility: "hidden" } as const

/**
 * Shows one of its variants, or none, in the space the largest of them takes,
 * so what follows stays where it is when the variant changes. A hidden variant
 * keeps its space, but can't be seen, focused or read by a screen reader.
 */
export function Reserved<K extends string>({ variants, shown, className }: ReservedProps<K>) {
  return (
    <span className={`grid ${className ?? ""}`}>
      {(Object.keys(variants) as K[]).map((key) => (
        <span key={key} className="[grid-area:1/1]" style={key === shown ? undefined : HIDDEN}>
          {variants[key]}
        </span>
      ))}
    </span>
  )
}
