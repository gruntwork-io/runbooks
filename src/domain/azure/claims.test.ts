import { describe, it, expect } from "bun:test"
import { decodeJwtPayload, principalFromClaims } from "./claims.ts"

const HOME = "141052b1-f3e4-49c2-91a3-dc349beb66f1"
const GUEST_TENANT = "05547fca-944c-4be0-9f4a-fac8b78fb1ab"

const jwt = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`

describe("decodeJwtPayload", () => {
  it("reads the payload of a JWT", () => {
    expect(decodeJwtPayload(jwt({ oid: "x" }))).toEqual({ oid: "x" })
  })

  it("returns undefined for something that isn't a JWT", () => {
    expect(decodeJwtPayload("not-a-token")).toBeUndefined()
    expect(decodeJwtPayload("a.!!!.c")).toBeUndefined()
  })
})

describe("principalFromClaims", () => {
  it("reads a member user", () => {
    expect(
      principalFromClaims({
        oid: "user-oid",
        tid: HOME,
        upn: "alice@contoso.com",
        name: "Alice",
        idtyp: "user",
      }),
    ).toEqual({
      name: "alice@contoso.com",
      objectId: "user-oid",
      type: "user",
      tenantId: HOME,
      displayName: "Alice",
    })
  })

  it("treats a user whose idp is its own tenant as a member", () => {
    expect(
      principalFromClaims({
        oid: "o",
        tid: HOME,
        upn: "a@b.com",
        idp: `https://sts.windows.net/${HOME}/`,
      })?.type,
    ).toBe("user")
  })

  it("reads a B2B guest from its idp, with its home tenant", () => {
    expect(
      principalFromClaims({
        oid: "guest-oid",
        tid: GUEST_TENANT,
        unique_name: "engineering@awsdevgruntwork.onmicrosoft.com",
        idp: `https://sts.windows.net/${HOME}/`,
        idtyp: "user",
      }),
    ).toEqual({
      name: "engineering@awsdevgruntwork.onmicrosoft.com",
      objectId: "guest-oid",
      type: "guest",
      tenantId: GUEST_TENANT,
      homeTenantId: HOME,
    })
  })

  it("reads a guest from a #EXT# UPN when there's no idp", () => {
    expect(
      principalFromClaims({
        oid: "o",
        tid: GUEST_TENANT,
        upn: "bob_contoso.com#EXT#@fabrikam.onmicrosoft.com",
      })?.type,
    ).toBe("guest")
  })

  it("reads a Microsoft account as a guest", () => {
    const principal = principalFromClaims({
      oid: "o",
      tid: GUEST_TENANT,
      unique_name: "live.com#bob@outlook.com",
      idp: "live.com",
    })
    expect(principal?.type).toBe("guest")
    expect(principal?.homeTenantId).toBeUndefined()
  })

  it("reads a service principal by its app ID", () => {
    expect(
      principalFromClaims({ oid: "sp-oid", tid: HOME, appid: "app-id", idtyp: "app" }),
    ).toEqual({ name: "app-id", objectId: "sp-oid", type: "servicePrincipal", tenantId: HOME })
  })

  it("returns undefined without an object ID or tenant", () => {
    expect(principalFromClaims({ tid: HOME, upn: "a@b.com" })).toBeUndefined()
    expect(principalFromClaims({ oid: "o", upn: "a@b.com" })).toBeUndefined()
  })
})
