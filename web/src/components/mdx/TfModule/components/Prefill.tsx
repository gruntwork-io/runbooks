import { useEffect, useRef } from "react"
import type { Use } from "../../../../../../src/domain/lookups/types"
import { useLookup } from "../hooks/useLookup"
import { suggestionFor } from "../lookupRows"

interface PrefillProps {
  prefill: Use
  /** Whether the input has no value of its own, so filling it overwrites nothing. */
  empty: boolean
  onFill: (value: string) => void
}

/**
 * Fills an empty input from its prefill lookup when that gives exactly one
 * row, such as the signed-in organization's customer ID. It fills each value the lookup gives
 * once, so an input the user clears stays clear until the lookup gives
 * another value, as after signing in to another organization. A lookup that
 * fails, or finds no row or several, leaves the input as it is.
 */
export function Prefill({ prefill, empty, onFill }: PrefillProps) {
  const { rows } = useLookup(prefill, "", true)
  const row = rows.length === 1 ? rows[0] : undefined
  const value = row ? suggestionFor(row).value : ""
  const filled = useRef("")

  useEffect(() => {
    if (!value || filled.current === value) return
    filled.current = value
    if (empty) onFill(value)
    // Fills when the lookup's value changes, not when the input does.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return null
}
