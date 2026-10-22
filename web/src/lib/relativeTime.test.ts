import { describe, it, expect } from "vitest"
import { formatTimeAgo } from "./relativeTime"

const NOW = Date.parse("2026-10-03T12:00:00.000Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe("formatTimeAgo", () => {
  it.each([
    ["just now", 0],
    ["just now", 59_999],
    ["1 minute ago", MINUTE],
    ["59 minutes ago", HOUR - 1],
    ["1 hour ago", HOUR],
    ["23 hours ago", DAY - 1],
    ["yesterday", DAY],
    ["29 days ago", 30 * DAY - 1],
  ])("says %s for a time that long ago", (expected, ms) => {
    expect(formatTimeAgo(ago(ms), NOW)).toBe(expected)
  })

  it("gives the date for a time 30 days or more ago", () => {
    expect(formatTimeAgo("2026-08-01T12:00:00.000Z", NOW)).toBe("Aug 1, 2026")
    expect(formatTimeAgo(ago(30 * DAY), NOW)).toBe("Sep 3, 2026")
  })

  it("says just now for a time in the future", () => {
    expect(formatTimeAgo(ago(-HOUR), NOW)).toBe("just now")
  })
})
