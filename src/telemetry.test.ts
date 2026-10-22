import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { generateAnonymousId, getConfig, init, isEnabled } from "./telemetry.ts"

const ENV_KEYS = ["MIXPANEL_TOKEN", "RUNBOOKS_TELEMETRY_DISABLE"] as const

describe("telemetry init", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      const value = process.env[key]
      if (value !== undefined) saved[key] = value
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key]
      const value = saved[key]
      if (value !== undefined) process.env[key] = value
    }
  })

  it("stays off without a Mixpanel token", () => {
    init("1.2.3", false)
    expect(isEnabled()).toBe(false)
    expect(getConfig()).toEqual({ enabled: false })
  })

  it("turns on with a token and gives the renderer its identity and version", () => {
    process.env.MIXPANEL_TOKEN = "test-token"
    init("1.2.3", false)
    expect(isEnabled()).toBe(true)
    expect(getConfig()).toEqual({
      enabled: true,
      token: "test-token",
      anonymousId: generateAnonymousId(),
      version: "1.2.3",
    })
  })

  it("stays off with --no-telemetry even when a token is set", () => {
    process.env.MIXPANEL_TOKEN = "test-token"
    init("1.2.3", true)
    expect(isEnabled()).toBe(false)
    expect(getConfig()).toEqual({ enabled: false })
  })

  it.each(["1", "true", "YES"])("stays off when RUNBOOKS_TELEMETRY_DISABLE=%s", (value) => {
    process.env.MIXPANEL_TOKEN = "test-token"
    process.env.RUNBOOKS_TELEMETRY_DISABLE = value
    init("1.2.3", false)
    expect(isEnabled()).toBe(false)
  })
})
