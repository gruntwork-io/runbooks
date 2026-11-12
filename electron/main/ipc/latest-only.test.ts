import { describe, it, expect } from "bun:test"
import { makeLatestOnly } from "./latest-only.ts"

describe("makeLatestOnly", () => {
  it("keeps the newest piece of work, whichever finishes first", () => {
    const latest = makeLatestOnly()
    const older = latest.begin()
    const newer = latest.begin()

    // The newer one finishing first, then the older one: only the newer counts.
    expect(newer()).toBe(true)
    expect(older()).toBe(false)
  })

  it("keeps a piece of work that nothing started after", () => {
    const latest = makeLatestOnly()
    const only = latest.begin()

    expect(only()).toBe(true)
    expect(only()).toBe(true)
  })

  it("drops everything started before an invalidate", () => {
    const latest = makeLatestOnly()
    const before = latest.begin()

    latest.invalidate()

    expect(before()).toBe(false)
    expect(latest.begin()()).toBe(true)
  })
})
