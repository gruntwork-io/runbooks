import { describe, it, expect } from "vitest"
import { bindByKind, verdictOf, type PreflightState } from "../preflight"
import type { Definitions } from "../../../../../../src/domain/lookups/types"

const definitions = {
  groups: {
    google: {
      name: "google",
      auth: "GoogleAuth",
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    },
  },
  lookups: {},
  checks: {
    "google.apiEnabled": {
      id: "google.apiEnabled",
      group: "google",
      params: ["api"],
      request: { method: "GET", url: "https://serviceusage.googleapis.com/v1/x", headers: {} },
      expect: { path: "state", equals: "ENABLED" },
      message: "off",
    },
  },
} as unknown as Definitions

const preflight = [{ from: "google.apiEnabled", with: { api: "admin.googleapis.com" } }]

const ready = (extra: Partial<Extract<PreflightState, { kind: "ready" }>>): PreflightState => ({
  kind: "ready",
  tools: [],
  inputs: {},
  problems: [],
  results: [],
  ...extra,
})

describe("bindByKind", () => {
  it("binds each group to the listed block of its kind", () => {
    const result = bindByKind(definitions, preflight, [
      { id: "prod", kind: "AwsAuth" },
      {
        id: "workspace",
        kind: "GoogleAuth",
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      },
    ])
    expect(result).toEqual({ binding: { google: "workspace" }, problems: [] })
  })

  it("says when no listed block is of the kind a group needs", () => {
    const { problems } = bindByKind(definitions, preflight, [{ id: "prod", kind: "AwsAuth" }])
    expect(problems).toEqual([
      "The module's google checks need a GoogleAuth block. Add one to the block's auth prop.",
    ])
  })

  it("says when the block doesn't request the group's scopes", () => {
    const { problems } = bindByKind(definitions, preflight, [
      { id: "workspace", kind: "GoogleAuth", scopes: [] },
    ])
    expect(problems[0]).toContain("doesn't request https://www.googleapis.com/auth/cloud-platform")
  })

  it("needs no block when the module has no checks", () => {
    expect(bindByKind(definitions, [], [])).toEqual({ binding: {}, problems: [] })
  })
})

describe("verdictOf", () => {
  const use = preflight[0]!
  it("plans when every check passed", () => {
    expect(verdictOf(ready({ results: [{ use, outcome: { outcome: "passed" } }] }))).toBe("go")
  })

  it("stops on a failed check, a binding problem, a missing tool or unpushed changes", () => {
    expect(
      verdictOf(ready({ results: [{ use, outcome: { outcome: "failed", message: "off" } }] })),
    ).toBe("stop")
    expect(verdictOf(ready({ problems: ["no block"] }))).toBe("stop")
    expect(verdictOf({ kind: "missing-tools", tools: [] })).toBe("stop")
    expect(verdictOf({ kind: "unpushed", tools: [], message: "push" })).toBe("stop")
  })

  it("asks when a check couldn't run, or the module's checks couldn't be read", () => {
    expect(
      verdictOf(ready({ results: [{ use, outcome: { outcome: "unknown", detail: "403" } }] })),
    ).toBe("ask")
    expect(verdictOf(ready({ moduleNote: "can't fetch" }))).toBe("ask")
  })
})
