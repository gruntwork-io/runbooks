import { describe, it, expect } from "vitest"
import { readinessReport } from "../readiness"
import type { RequiredApi } from "../../../../../../src/domain/tf-module/requirements"

const APIS: RequiredApi[] = [
  { service: "cloudidentity.googleapis.com", name: "Cloud Identity API", neededFor: "apply" },
  { service: "admin.googleapis.com", name: "Admin SDK API", neededFor: "suggestions" },
]
const TOFU = { command: "tofu", found: true, version: "1.12.6", install: "https://opentofu.org" }

describe("readinessReport", () => {
  it("says what's ready when nothing is missing", () => {
    const report = readinessReport(APIS, {
      google: {
        kind: "checked",
        project: "acme-ops",
        enabled: { "cloudidentity.googleapis.com": true, "admin.googleapis.com": true },
      },
      tools: [TOFU],
    })
    expect(report).toEqual({
      problems: [],
      ready: ["2 Google APIs on in acme-ops", "OpenTofu 1.12.6"],
    })
  })

  it("gives each off API a link that turns it on, and says whether the plan needs it", () => {
    const report = readinessReport(APIS, {
      google: {
        kind: "checked",
        project: "acme-ops",
        enabled: { "cloudidentity.googleapis.com": false, "admin.googleapis.com": false },
      },
      tools: [{ command: "tofu", found: false, install: "https://opentofu.org" }],
    })
    expect(report.ready).toEqual([])
    expect(report.problems.map((p) => [p.key, p.text, p.fix?.label])).toEqual([
      [
        "cloudidentity.googleapis.com",
        "The Cloud Identity API is off in acme-ops, and the plan needs it.",
        "Turn it on",
      ],
      [
        "admin.googleapis.com",
        "The Admin SDK API is off in acme-ops, so its suggestions won't load. Typed values still work.",
        "Turn it on",
      ],
      ["tofu", "OpenTofu isn't on your PATH, and the plan runs it.", "Install OpenTofu"],
    ])
    expect(report.problems[0]!.fix!.url).toBe(
      "https://console.cloud.google.com/apis/library/cloudidentity.googleapis.com?project=acme-ops",
    )
  })

  it("asks for a sign-in only when the plan needs Google", () => {
    const signedOut = { google: { kind: "signed-out" as const }, tools: [] }
    expect(readinessReport(APIS, signedOut).problems).toHaveLength(1)
    expect(readinessReport([APIS[1]!], signedOut).problems).toEqual([])
  })
})
