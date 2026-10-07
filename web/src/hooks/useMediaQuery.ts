import { useSyncExternalStore } from "react"

/**
 * Whether the viewport is at least Tailwind's `lg` breakpoint, where the
 * runbook and the generated files sit side by side instead of behind the
 * Markdown / Code tabs. Mirrors `--breakpoint-lg` in css/App.css.
 */
export const DESKTOP_LAYOUT_QUERY = "(min-width: 1250px)"

/** Whether `query` currently matches, re-rendering as it changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query)
      mq.addEventListener("change", onChange)
      return () => mq.removeEventListener("change", onChange)
    },
    () => window.matchMedia(query).matches,
  )
}
