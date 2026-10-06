const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
const date = new Intl.DateTimeFormat("en", { dateStyle: "medium" })

/**
 * When `iso` was, relative to `now` within a month ("just now", "5 minutes
 * ago", "yesterday", "3 days ago"), and as a date before that. A time in the
 * future, from a clock that moved back, counts as just now.
 */
export function formatTimeAgo(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  const elapsed = now - at
  if (elapsed < MINUTE) return "just now"
  if (elapsed < HOUR) return relative.format(-Math.floor(elapsed / MINUTE), "minute")
  if (elapsed < DAY) return relative.format(-Math.floor(elapsed / HOUR), "hour")
  if (elapsed < 30 * DAY) return relative.format(-Math.floor(elapsed / DAY), "day")
  return date.format(at)
}
