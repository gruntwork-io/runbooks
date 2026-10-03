import { useEffect, useState } from "react"

/** How long before its credential expires an auth block asks to sign in again. */
export const EXPIRY_WARNING_MS = 5 * 60_000

// setTimeout runs a callback at once when its delay is over 2^31 - 1 ms (about 24.8 days).
const MAX_TIMER_MS = 2 ** 31 - 1

export type CredentialExpiry = "valid" | "expiring" | "expired"

function expiryAt(expiresAt: number, now: number): CredentialExpiry {
  if (now >= expiresAt) return "expired"
  return now >= expiresAt - EXPIRY_WARNING_MS ? "expiring" : "valid"
}

/**
 * Where a credential that expires at `expiresAt`, an ISO timestamp, stands:
 * `expiring` from EXPIRY_WARNING_MS before then, and `expired` from then on.
 * The component re-renders as the credential moves from one to the next.
 *
 * Undefined for a credential with no expiry, or one that isn't a date.
 */
export function useCredentialExpiry(expiresAt: string | undefined): CredentialExpiry | undefined {
  const at = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (Number.isNaN(at)) return
    const current = Date.now()
    const next = [at - EXPIRY_WARNING_MS, at].find((t) => t > current)
    // `now` is behind when the credential changed since it was read: catch up at once.
    const delay =
      expiryAt(at, now) !== expiryAt(at, current)
        ? 0
        : next === undefined
          ? undefined
          : Math.min(next - current, MAX_TIMER_MS)
    if (delay === undefined) return
    const timer = setTimeout(() => setNow(Date.now()), delay)
    return () => clearTimeout(timer)
  }, [at, now])

  return Number.isNaN(at) ? undefined : expiryAt(at, now)
}
