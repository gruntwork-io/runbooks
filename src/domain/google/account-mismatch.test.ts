import { describe, it, expect } from "bun:test"
import { differsFromConfirmedPrincipal, namesAnotherAccount } from "./account-mismatch.ts"

describe("namesAnotherAccount", () => {
  const userLogin = (email: string) => ({ email, credentialType: "authorized_user" as const })

  it("is true when the configuration's account differs from the account that signed in", () => {
    expect(namesAnotherAccount("ana@example.com", userLogin("ben@example.org"))).toBe(true)
  })

  it("is false when they are the same account in a different case", () => {
    expect(namesAnotherAccount("Ana@Example.com", userLogin("ana@example.com"))).toBe(false)
  })

  it("is false when the configuration names no account", () => {
    expect(namesAnotherAccount(undefined, userLogin("ana@example.com"))).toBe(false)
  })

  it("is false when Google did not report the credential's email", () => {
    expect(namesAnotherAccount("ana@example.com", userLogin(""))).toBe(false)
  })

  it.each(["service_account", "impersonated_service_account", "external_account"] as const)(
    "is false for a %s credential, whose email is never a configuration's account",
    (credentialType) => {
      const signedIn = { email: "deployer@proj.iam.gserviceaccount.com", credentialType }
      expect(namesAnotherAccount("ana@example.com", signedIn)).toBe(false)
    },
  )
})

describe("differsFromConfirmedPrincipal", () => {
  it("is true when the credential signs in as a different account", () => {
    expect(differsFromConfirmedPrincipal("ana@example.com", { email: "ben@example.org" })).toBe(
      true,
    )
  })

  it("is true for a different service account", () => {
    const confirmed = "deployer@proj.iam.gserviceaccount.com"
    const signedIn = { email: "reader@proj.iam.gserviceaccount.com" }
    expect(differsFromConfirmedPrincipal(confirmed, signedIn)).toBe(true)
  })

  it("is false when it is the same account in a different case", () => {
    expect(differsFromConfirmedPrincipal("Ana@Example.com", { email: "ana@example.com" })).toBe(
      false,
    )
  })

  it("is false when the caller confirmed no account", () => {
    expect(differsFromConfirmedPrincipal(undefined, { email: "ana@example.com" })).toBe(false)
  })

  it("is false when Google did not report the credential's email", () => {
    expect(differsFromConfirmedPrincipal("ana@example.com", { email: "" })).toBe(false)
  })
})
