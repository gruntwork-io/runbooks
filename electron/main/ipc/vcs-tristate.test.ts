import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import { runtime } from "./runtime.ts"
import * as systemTrust from "../system-trust.ts"
import { VcsCredentials } from "../../../src/services/VcsCredentials.ts"
import type {
  CliValidation,
  DetectionResult,
  VcsCredentialSource,
  VcsCredentialsShape,
} from "../../../src/services/VcsCredentials.ts"
import { VcsCliError } from "../../../src/errors/index.ts"

// vcs-tristate.ts reaches electron only through window.ts (getMainWindow),
// and electron cannot load under Bun. Mock window.ts rather than electron:
// Bun module mocks outlive the test file and fix the export names on first
// import, so a second electron mock with other names (theme-store.test.ts)
// would collide with this one. There is no window in these tests.
mock.module("../window.ts", () => ({ getMainWindow: () => null }))

const { withTlsOrchestration } = await import("./vcs-tristate.ts")

const HOST = "gitlab.corp.example"

const TLS_WALL: DetectionResult = {
  outcome: "unreachable",
  errorKind: "tls",
  token: "glpat-token",
  source: "cli",
  warnings: [],
  error: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
}
const VALID: DetectionResult = {
  outcome: "valid",
  token: "glpat-token",
  source: "cli",
  user: { login: "direct-user" },
  warnings: [],
}
const NETWORK: DetectionResult = { ...TLS_WALL, errorKind: "network", error: "ECONNREFUSED" }
const SERVER_CERT: DetectionResult = { ...TLS_WALL, errorKind: "server-cert", error: "CERT_HAS_EXPIRED" }
const INVALID: DetectionResult = { outcome: "invalid", token: "glpat-token", source: "env", warnings: [], status: 401 }

/** A detect step that returns `results` in order, repeating the last one. */
const detectSequence = (...results: DetectionResult[]) => {
  let call = 0
  return mock(async () => results[Math.min(call++, results.length - 1)])
}

let probeResult: Effect.Effect<CliValidation, VcsCliError>
let probeCalls: Array<{ host: string; token: string; source: VcsCredentialSource }>
let degraded: Array<{ host: string; code: string }>
let refresh: ReturnType<typeof spyOn<typeof systemTrust, "refreshSystemTrust">>

// Only the two methods the orchestration calls.
const vcsLayer = Layer.succeed(VcsCredentials, {
  validateViaCli: (_provider, host, token, source) =>
    Effect.suspend(() => {
      probeCalls.push({ host, token, source })
      return probeResult
    }),
  markTransportDegraded: (host, code) => Effect.sync(() => void degraded.push({ host, code })),
} as Pick<VcsCredentialsShape, "validateViaCli" | "markTransportDegraded"> as VcsCredentialsShape)

beforeEach(() => {
  probeResult = Effect.fail(new VcsCliError({ kind: "api", stderr: "401 Unauthorized" }))
  probeCalls = []
  degraded = []
  refresh = spyOn(systemTrust, "refreshSystemTrust").mockResolvedValue({ coldReadOk: true })
  spyOn(runtime, "runPromise").mockImplementation(((effect: Effect.Effect<unknown, unknown, VcsCredentials>) =>
    Effect.runPromise(Effect.provide(effect, vcsLayer))) as typeof runtime.runPromise)
  spyOn(runtime, "runPromiseExit").mockImplementation(((effect: Effect.Effect<unknown, unknown, VcsCredentials>) =>
    Effect.runPromiseExit(Effect.provide(effect, vcsLayer))) as typeof runtime.runPromiseExit)
})

afterEach(() => {
  mock.restore()
})

describe("withTlsOrchestration", () => {
  it.each([
    ["valid", VALID],
    ["invalid", INVALID],
    ["network", NETWORK],
    ["server-cert", SERVER_CERT],
  ])("returns a %s result as-is, with no refresh, retry or probe", async (_name, first) => {
    const detect = detectSequence(first)

    const result = await withTlsOrchestration({ provider: "gitlab", host: HOST, detect })

    expect(result).toBe(first)
    expect(detect).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
    expect(probeCalls).toEqual([])
  })

  it.each([
    ["valid", VALID],
    ["network", NETWORK],
  ])("on a tls failure, refreshes trust once and returns the retry's %s result", async (_name, retry) => {
    const detect = detectSequence(TLS_WALL, retry)

    const result = await withTlsOrchestration({ provider: "gitlab", host: HOST, detect })

    expect(result).toBe(retry)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(detect).toHaveBeenCalledTimes(2)
    expect(probeCalls).toEqual([])
  })

  it("accepts a persisting tls wall via the CLI probe and marks the host degraded", async () => {
    probeResult = Effect.succeed({ user: { login: "cli-user" }, scopes: ["api"] })
    const detect = detectSequence(TLS_WALL)

    const result = await withTlsOrchestration({ provider: "gitlab", host: HOST, detect })

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(detect).toHaveBeenCalledTimes(2)
    expect(probeCalls).toEqual([{ host: HOST, token: "glpat-token", source: "cli" }])
    expect(degraded).toEqual([{ host: HOST, code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }])
    expect(result).toMatchObject({
      outcome: "valid",
      user: { login: "cli-user" },
      scopes: ["api"],
      validatedVia: "cli",
    })
  })

  it("probes with probeSource instead of the result's source", async () => {
    const detect = detectSequence({ ...TLS_WALL, source: "env" })

    await withTlsOrchestration({ provider: "gitlab", host: HOST, detect, probeSource: "manual" })

    expect(probeCalls).toEqual([{ host: HOST, token: "glpat-token", source: "manual" }])
  })

  it.each([
    ["token", { ...TLS_WALL, token: undefined }],
    ["source", { ...TLS_WALL, source: undefined }],
  ])("skips the probe without a %s and returns the tls result", async (_name, wall) => {
    const detect = detectSequence(wall)

    const result = await withTlsOrchestration({ provider: "gitlab", host: HOST, detect })

    expect(probeCalls).toEqual([])
    expect(result).toEqual({ ...wall, coldReadOk: true })
  })

  it("degrades to the tls result carrying the refresh's coldReadOk when the probe fails", async () => {
    refresh.mockResolvedValue({ coldReadOk: false })
    const detect = detectSequence(TLS_WALL)

    const result = await withTlsOrchestration({ provider: "gitlab", host: HOST, detect })

    expect(probeCalls).toHaveLength(1)
    expect(degraded).toEqual([])
    expect(result).toEqual({ ...TLS_WALL, coldReadOk: false })
  })
})
