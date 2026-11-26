import { describe, it, expect } from "vitest"
import { planSignIn } from "../signInPlan"
import type { GoogleAuthMethod } from "../types"

describe("planSignIn without the methods prop", () => {
  it("offers every method, opens on the key tab and checks the gcloud login", () => {
    expect(planSignIn({})).toEqual({
      methods: ["service_account", "oauth", "gcloud"],
      openingMethod: "service_account",
      detectCredentials: ["env", "adc"],
    })
  })

  it("opens on defaultTab, and falls back for a name it does not know", () => {
    expect(planSignIn({ defaultTab: "gcloud" }).openingMethod).toBe("gcloud")
    expect(planSignIn({ defaultTab: "sso" as GoogleAuthMethod })).toEqual(planSignIn({}))
  })

  it("keeps the author's detectCredentials", () => {
    expect(planSignIn({ detectCredentials: false }).detectCredentials).toBe(false)
    expect(planSignIn({ detectCredentials: ["gcloud"] }).detectCredentials).toEqual(["gcloud"])
  })
})

describe("planSignIn with the methods prop", () => {
  it("offers the listed methods in order and opens on the first", () => {
    expect(planSignIn({ methods: ["gcloud", "oauth"] })).toEqual({
      methods: ["gcloud", "oauth"],
      openingMethod: "gcloud",
      detectCredentials: ["env", "adc"],
    })
  })

  it("opens on defaultTab when the list has it", () => {
    const plan = planSignIn({ methods: ["gcloud", "oauth"], defaultTab: "oauth" })
    expect(plan.openingMethod).toBe("oauth")
    expect(plan.configurationError).toBeUndefined()
  })

  it("does not check the gcloud login when gcloud is not listed", () => {
    expect(planSignIn({ methods: ["oauth"] }).detectCredentials).toEqual(["env"])
    expect(planSignIn({ methods: ["oauth", "service_account"] }).detectCredentials).toEqual(["env"])
  })

  it("keeps a detectCredentials that stays inside the list", () => {
    const sources = [{ env: { prefix: "PROD_" } }, { block: "impersonate" }]
    expect(planSignIn({ methods: ["oauth"], detectCredentials: sources })).toEqual({
      methods: ["oauth"],
      openingMethod: "oauth",
      detectCredentials: sources,
    })
    expect(
      planSignIn({ methods: ["gcloud"], detectCredentials: ["adc"] }).configurationError,
    ).toBeUndefined()
  })

  it("lists a repeated method once", () => {
    expect(planSignIn({ methods: ["oauth", "gcloud", "oauth"] }).methods).toEqual([
      "oauth",
      "gcloud",
    ])
  })
})

describe("planSignIn configuration errors", () => {
  const errorFor = (props: Parameters<typeof planSignIn>[0]) => planSignIn(props).configurationError

  it("rejects an empty list and a value that is not a list", () => {
    const expected = "The methods prop must list at least one of: service_account, oauth, gcloud."
    expect(errorFor({ methods: [] })).toBe(expected)
    expect(errorFor({ methods: "oauth" as unknown as GoogleAuthMethod[] })).toBe(expected)
  })

  it("rejects a method name it does not know", () => {
    expect(errorFor({ methods: ["oauth", "sso" as GoogleAuthMethod] })).toBe(
      'The methods prop lists "sso". Use only: service_account, oauth, gcloud.',
    )
  })

  it("rejects a defaultTab the list leaves out", () => {
    expect(errorFor({ methods: ["oauth"], defaultTab: "gcloud" })).toBe(
      'The defaultTab prop is "gcloud", which the methods prop does not list.',
    )
  })

  it("rejects a detection source that reads the gcloud login when gcloud is not listed", () => {
    expect(errorFor({ methods: ["oauth"], detectCredentials: ["env", "adc"] })).toBe(
      "The detectCredentials prop includes 'adc', which reads the gcloud login, but the methods prop does not list gcloud.",
    )
    expect(errorFor({ methods: ["oauth"], detectCredentials: ["gcloud"] })).toBe(
      "The detectCredentials prop includes 'gcloud', which reads the gcloud login, but the methods prop does not list gcloud.",
    )
  })

  it("turns detection off while the configuration is wrong", () => {
    expect(planSignIn({ methods: [] }).detectCredentials).toBe(false)
  })
})
