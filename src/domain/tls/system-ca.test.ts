import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { classifyTlsError, dedupePems, installSystemTrust, refreshSystemPems } from "./system-ca.ts"
import type { CaSources } from "./system-ca.ts"

const PEM_A = "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----"
const PEM_B = "-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----"
const PEM_C = "-----BEGIN CERTIFICATE-----\nCCC\n-----END CERTIFICATE-----"
const PEM_D = "-----BEGIN CERTIFICATE-----\nDDD\n-----END CERTIFICATE-----"

/**
 * A fake tls module: `installed` mirrors what setDefaultCACertificates would
 * have installed, while `bundledDefaults` keeps returning the launch-time
 * snapshot — the discipline that prevents extras from compounding into the
 * base across re-installs.
 */
const makeFakeTls = (bundled: string[], system: string[]) => {
  const snapshot = [...bundled]
  let installed: string[] = []
  const io: CaSources = {
    bundledDefaults: () => [...snapshot],
    systemPems: () => Effect.succeed([...system]),
    setCAs: (certs) => {
      installed = [...certs]
    },
  }
  return { io, installed: () => installed }
}

describe("dedupePems", () => {
  it("removes exact and whitespace-variant duplicates, preserving first-seen order", () => {
    expect(dedupePems([PEM_B, PEM_A, `${PEM_B}\n`, PEM_A])).toEqual([PEM_B, PEM_A])
  })

  it("drops empty entries", () => {
    expect(dedupePems(["", "  \n", PEM_A])).toEqual([PEM_A])
  })
})

describe("installSystemTrust", () => {
  it("installs the union in source order (defaults, system, extra) and returns pre-dedupe counts", async () => {
    const { io, installed } = makeFakeTls([PEM_A], [PEM_B])
    const counts = await Effect.runPromise(installSystemTrust([PEM_C], io))

    expect(installed()).toEqual([PEM_A, PEM_B, PEM_C])
    expect(counts).toEqual({ defaults: 1, system: 1, extra: 1 })
  })

  it("dedupes across sources (a system cert already in the defaults appears once)", async () => {
    const { io, installed } = makeFakeTls([PEM_A, PEM_B], [PEM_B, PEM_C])
    const counts = await Effect.runPromise(installSystemTrust([PEM_A], io))

    expect(installed()).toEqual([PEM_A, PEM_B, PEM_C])
    // Counts are per-source inputs, not the deduped union.
    expect(counts).toEqual({ defaults: 2, system: 2, extra: 1 })
  })

  it("is idempotent: re-running never compounds extras into the base (snapshot discipline)", async () => {
    const { io, installed } = makeFakeTls([PEM_A], [PEM_B])

    await Effect.runPromise(installSystemTrust([PEM_C], io))
    const first = installed()
    // A naive implementation would now re-read "default" — which after the
    // install returns the union — and append the extras again. The CaSources
    // snapshot makes the second run identical.
    await Effect.runPromise(installSystemTrust([PEM_C], io))

    expect(installed()).toEqual(first)
    expect(installed().filter((pem) => pem === PEM_C)).toHaveLength(1)
  })
})

describe("refreshSystemPems", () => {
  it("consumes the cold reader's output on success (coldReadOk: true)", async () => {
    const result = await Effect.runPromise(refreshSystemPems(Effect.succeed([PEM_C, PEM_D]), [PEM_B]))
    expect(result).toEqual({ pems: [PEM_C, PEM_D], coldReadOk: true })
  })

  it("falls back to the launch-time set on any cold-read failure (coldReadOk: false)", async () => {
    const result = await Effect.runPromise(
      refreshSystemPems(Effect.fail(new Error("spawn ENOENT")), [PEM_B]),
    )
    expect(result).toEqual({ pems: [PEM_B], coldReadOk: false })
  })

  it("feeds the fallback set into installSystemTrust unchanged", async () => {
    const { io: base, installed } = makeFakeTls([PEM_A], [])
    const refreshed = await Effect.runPromise(
      refreshSystemPems(Effect.fail(new Error("timeout")), [PEM_B]),
    )
    const io: CaSources = { ...base, systemPems: () => Effect.succeed(refreshed.pems) }
    await Effect.runPromise(installSystemTrust([], io))

    expect(installed()).toEqual([PEM_A, PEM_B])
  })
})

describe("classifyTlsError", () => {
  /** The exact rejection shape of undici's global fetch: TypeError("fetch
   *  failed") with the OpenSSL/syscall code on .cause. */
  const undiciWrapped = (code: string) =>
    new TypeError("fetch failed", { cause: Object.assign(new Error(`boom: ${code}`), { code }) })

  it.each([
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    // Chromium code, future-proofing for net.fetch (§3.2 escape route).
    "ERR_CERT_AUTHORITY_INVALID",
  ])("classifies undici-wrapped %s as 'tls'", (code) => {
    expect(classifyTlsError(undiciWrapped(code))).toBe("tls")
  })

  it.each(["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"])(
    "classifies undici-wrapped %s as 'server-cert' (not trust-fixable)",
    (code) => {
      expect(classifyTlsError(undiciWrapped(code))).toBe("server-cert")
    },
  )

  it.each(["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"])(
    "classifies undici-wrapped %s as 'network'",
    (code) => {
      expect(classifyTlsError(undiciWrapped(code))).toBe("network")
    },
  )

  it("unwraps AggregateError.errors nested inside the cause chain", () => {
    // Happy-Eyeballs-style failure: connects to multiple resolved addresses
    // all refused, surfaced as TypeError -> AggregateError -> [Error, Error].
    const aggregate = new AggregateError(
      [
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("connect ECONNREFUSED ::1:443"), { code: "ECONNREFUSED" }),
      ],
      "",
    )
    expect(classifyTlsError(new TypeError("fetch failed", { cause: aggregate }))).toBe("network")
  })

  it("classifies a bare error carrying the code directly (no wrapper)", () => {
    expect(classifyTlsError(Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" }))).toBe(
      "server-cert",
    )
  })

  it("prefers the most specific class when multiple codes appear in one chain", () => {
    const cause = Object.assign(new Error("tls"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
      cause: Object.assign(new Error("net"), { code: "ECONNREFUSED" }),
    })
    expect(classifyTlsError(new TypeError("fetch failed", { cause }))).toBe("tls")
  })

  it("returns undefined for HTTP-level failures and unknown errors", () => {
    expect(classifyTlsError(new Error("401 Unauthorized"))).toBeUndefined()
    expect(classifyTlsError(new TypeError("fetch failed"))).toBeUndefined()
    expect(classifyTlsError(undefined)).toBeUndefined()
    expect(classifyTlsError("string error")).toBeUndefined()
    expect(classifyTlsError(Object.assign(new Error("x"), { code: 42 }))).toBeUndefined()
  })

  it("survives cyclic cause chains", () => {
    const a: { code?: string; cause?: unknown } = new Error("a")
    const b: { code?: string; cause?: unknown } = new Error("b")
    a.cause = b
    b.cause = a
    expect(classifyTlsError(a)).toBeUndefined()
    ;(b as { code?: string }).code = "ENOTFOUND"
    expect(classifyTlsError(a)).toBe("network")
  })
})
