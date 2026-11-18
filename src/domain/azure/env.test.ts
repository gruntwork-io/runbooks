import { describe, it, expect } from "bun:test"
import { azureSessionEnv, AZURE_CREDENTIAL_ENV_VARS } from "./env.ts"
import { AZURE_AUTH_ENV_VARS } from "../exec/authEnv.ts"
import type { AzurePrincipal } from "./claims.ts"

const USER: AzurePrincipal = {
  name: "alice@contoso.com",
  objectId: "user-oid",
  type: "user",
  tenantId: "tenant-1",
}
const SP: AzurePrincipal = {
  name: "app-id",
  objectId: "sp-oid",
  type: "servicePrincipal",
  tenantId: "tenant-1",
}

describe("azureSessionEnv", () => {
  it("points a CLI sign-in at its config dir and turns on ARM_USE_CLI", () => {
    const { set, clear } = azureSessionEnv({
      authType: "cli",
      configDir: "/tmp/runbooks-azure-1",
      principal: USER,
      tenantId: "tenant-1",
      subscriptionId: "sub-1",
    })
    expect(set).toEqual({
      AZURE_CONFIG_DIR: "/tmp/runbooks-azure-1",
      AZURE_EXTENSION_DIR: "/tmp/runbooks-azure-1/cliextensions",
      AZURE_TENANT_ID: "tenant-1",
      ARM_TENANT_ID: "tenant-1",
      AZURE_SUBSCRIPTION_ID: "sub-1",
      ARM_SUBSCRIPTION_ID: "sub-1",
      ARM_USE_CLI: "true",
      AZURE_AUTH_TYPE: "cli",
      AZURE_PRINCIPAL_NAME: "alice@contoso.com",
      AZURE_PRINCIPAL_OBJECT_ID: "user-oid",
      AZURE_PRINCIPAL_TYPE: "user",
    })
    // Another block's service principal must not survive in the session.
    expect(clear).toEqual([
      "ARM_CLIENT_ID",
      "ARM_CLIENT_SECRET",
      "ARM_CLIENT_CERTIFICATE_PATH",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_CLIENT_CERTIFICATE_PATH",
    ])
  })

  it("clears the subscription of a tenant-level sign-in", () => {
    const { set, clear } = azureSessionEnv({
      authType: "device_code",
      configDir: "/d",
      principal: { ...USER, type: "guest" },
      tenantId: "tenant-1",
    })
    expect(set.ARM_SUBSCRIPTION_ID).toBeUndefined()
    expect(set.AZURE_PRINCIPAL_TYPE).toBe("guest")
    expect(clear).toContain("ARM_SUBSCRIPTION_ID")
    expect(clear).toContain("AZURE_SUBSCRIPTION_ID")
  })

  it("passes a service principal's secret under the azurerm and SDK names, without ARM_USE_CLI", () => {
    const { set, clear } = azureSessionEnv({
      authType: "service_principal",
      configDir: "/d",
      principal: SP,
      tenantId: "tenant-1",
      clientId: "app-id",
      clientSecret: "s3cret",
    })
    expect(set.ARM_CLIENT_ID).toBe("app-id")
    expect(set.ARM_CLIENT_SECRET).toBe("s3cret")
    expect(set.AZURE_CLIENT_SECRET).toBe("s3cret")
    expect(set.ARM_USE_CLI).toBeUndefined()
    expect(clear).toContain("ARM_USE_CLI")
  })

  it("passes a PFX certificate to azurerm, and a PEM one only to the SDKs", () => {
    const pfx = azureSessionEnv({
      authType: "service_principal",
      configDir: "/d",
      principal: SP,
      tenantId: "t",
      clientId: "app-id",
      certificatePath: "/keys/sp.pfx",
    })
    expect(pfx.set.ARM_CLIENT_CERTIFICATE_PATH).toBe("/keys/sp.pfx")
    expect(pfx.set.ARM_USE_CLI).toBeUndefined()

    const pem = azureSessionEnv({
      authType: "service_principal",
      configDir: "/d",
      principal: SP,
      tenantId: "t",
      clientId: "app-id",
      certificatePath: "/keys/sp.pem",
    })
    expect(pem.set.ARM_CLIENT_CERTIFICATE_PATH).toBeUndefined()
    expect(pem.set.AZURE_CLIENT_CERTIFICATE_PATH).toBe("/keys/sp.pem")
    expect(pem.set.ARM_USE_CLI).toBe("true")
  })

  it("only ever names vars an azureAuthId step may pass", () => {
    const allowed = new Set<string>(AZURE_AUTH_ENV_VARS)
    for (const name of AZURE_CREDENTIAL_ENV_VARS) expect(allowed.has(name)).toBe(true)
    const { set } = azureSessionEnv({
      authType: "service_principal",
      configDir: "/d",
      principal: SP,
      tenantId: "t",
      subscriptionId: "s",
      clientId: "c",
      clientSecret: "x",
    })
    for (const name of Object.keys(set)) expect(allowed.has(name)).toBe(true)
  })
})
