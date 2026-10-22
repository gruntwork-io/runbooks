import { useSyncExternalStore } from "react"

/**
 * Whether the viewport is at least Tailwind's `lg` breakpoint, where the
 * runbook and the generated files sit side by side instead of behind the
 * Markdown / Code tabs. Must agree with `--breakpoint-lg` in css/App.css,
 * which this hook's test checks.
 */
export const DESKTOP_LAYOUT_QUERY = "(min-width: 1250px)"

/** Whether `query` currently matches, re-rendering as it changes. */
export function useMediaQuery(query: string): boolean {
  // One list per query, which both callbacks below share.
  const mq = window.matchMedia(query)
  return useSyncExternalStore(
    (onChange) => {
      mq.addEventListener("change", onChange)
      return () => mq.removeEventListener("change", onChange)
    },
    () => mq.matches,
  )
}
