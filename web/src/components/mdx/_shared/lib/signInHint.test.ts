import { describe, it, expect } from "vitest"
import { signInHint } from "./signInHint"

describe("signInHint", () => {
  const none = { invalidDetected: false, nothingDetected: false, signInFailed: false }

  it("says nothing was found only when detection found nothing and no sign-in failed", () => {
    expect(signInHint({ ...none, nothingDetected: true })).toBe(
      "No existing credentials found. Sign in below.",
    )
  })

  it("asks to fix the credentials after a failed sign-in, even when detection found nothing", () => {
    expect(signInHint({ ...none, nothingDetected: true, signInFailed: true })).toBe(
      "Fix the credentials, or sign in below.",
    )
    expect(signInHint({ ...none, invalidDetected: true })).toBe(
      "Fix the credentials, or sign in below.",
    )
  })

  it("offers other credentials otherwise", () => {
    expect(signInHint(none)).toBe("Sign in below with different credentials.")
  })
})
