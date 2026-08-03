import { describe, expect, it } from "bun:test"
import {
  credentialSubjectToScopeCheck,
  evaluateRequiredGoogleScopes,
  expandGoogleScopes,
  formatGcloudAdcLoginCommand,
  insufficientScopesErrorMessage,
  missingGoogleScopes,
} from "./scopes.ts"

const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform"
const DIRECTORY = "https://www.googleapis.com/auth/admin.directory.rolemanagement"
const EMAIL = "https://www.googleapis.com/auth/userinfo.email"

describe("expandGoogleScopes", () => {
  it("splits space-separated grants from tokeninfo", () => {
    expect(expandGoogleScopes([`${CLOUD_PLATFORM} ${EMAIL}`, "openid"])).toEqual([
      CLOUD_PLATFORM,
      EMAIL,
      "openid",
    ])
  })

  it("returns an empty list for absent grants", () => {
    expect(expandGoogleScopes(undefined)).toEqual([])
    expect(expandGoogleScopes([])).toEqual([])
  })
})

describe("missingGoogleScopes", () => {
  it("returns nothing when the author set no requirements", () => {
    expect(missingGoogleScopes(undefined, [CLOUD_PLATFORM])).toEqual([])
    expect(missingGoogleScopes([], [CLOUD_PLATFORM])).toEqual([])
  })

  it("returns the scopes the grant does not cover", () => {
    expect(missingGoogleScopes([CLOUD_PLATFORM, DIRECTORY, EMAIL], [CLOUD_PLATFORM, EMAIL])).toEqual([
      DIRECTORY,
    ])
  })

  it("treats a full match as satisfied", () => {
    expect(
      missingGoogleScopes([CLOUD_PLATFORM, DIRECTORY], [DIRECTORY, CLOUD_PLATFORM, EMAIL]),
    ).toEqual([])
  })
})

describe("credentialSubjectToScopeCheck", () => {
  it("skips service-account shaped credentials", () => {
    expect(credentialSubjectToScopeCheck("service_account", "authorized_user")).toBe(false)
    expect(credentialSubjectToScopeCheck("user", "service_account")).toBe(false)
    expect(credentialSubjectToScopeCheck("user", "impersonated_service_account")).toBe(false)
  })

  it("applies to user ADC and bare access tokens", () => {
    expect(credentialSubjectToScopeCheck("user", "authorized_user")).toBe(true)
    expect(credentialSubjectToScopeCheck("user", "access_token")).toBe(true)
    expect(credentialSubjectToScopeCheck(undefined, "authorized_user")).toBe(true)
  })
})

describe("evaluateRequiredGoogleScopes", () => {
  it("passes when scopes were not declared", () => {
    expect(
      evaluateRequiredGoogleScopes({
        granted: [CLOUD_PLATFORM],
        accountType: "user",
        credentialType: "authorized_user",
      }),
    ).toEqual({ ok: true })
  })

  it("passes for service accounts even when scopes are missing", () => {
    expect(
      evaluateRequiredGoogleScopes({
        required: [DIRECTORY],
        granted: [CLOUD_PLATFORM],
        accountType: "service_account",
        credentialType: "service_account",
      }),
    ).toEqual({ ok: true })
  })

  it("fails for user ADC missing a required scope", () => {
    expect(
      evaluateRequiredGoogleScopes({
        required: [CLOUD_PLATFORM, DIRECTORY],
        granted: [CLOUD_PLATFORM],
        accountType: "user",
        credentialType: "authorized_user",
      }),
    ).toEqual({
      ok: false,
      missing: [DIRECTORY],
      granted: [CLOUD_PLATFORM],
    })
  })

  it("treats an empty grant on a user credential as missing every required scope", () => {
    expect(
      evaluateRequiredGoogleScopes({
        required: [CLOUD_PLATFORM, DIRECTORY],
        accountType: "user",
        credentialType: "authorized_user",
      }),
    ).toEqual({
      ok: false,
      missing: [CLOUD_PLATFORM, DIRECTORY],
      granted: [],
    })
  })
})

describe("formatGcloudAdcLoginCommand", () => {
  it("omits --scopes when none were requested", () => {
    expect(formatGcloudAdcLoginCommand([])).toBe("gcloud auth application-default login")
  })

  it("joins scopes for the directory-grants shape", () => {
    expect(formatGcloudAdcLoginCommand([CLOUD_PLATFORM, DIRECTORY, EMAIL, "openid"])).toBe(
      `gcloud auth application-default login --scopes=${CLOUD_PLATFORM},${DIRECTORY},${EMAIL},openid`,
    )
  })
})

describe("insufficientScopesErrorMessage", () => {
  it("lists the missing scopes and the recovery command", () => {
    const message = insufficientScopesErrorMessage([DIRECTORY], [CLOUD_PLATFORM, DIRECTORY])
    expect(message).toContain(DIRECTORY)
    expect(message).toContain(
      `gcloud auth application-default login --scopes=${CLOUD_PLATFORM},${DIRECTORY}`,
    )
  })
})
