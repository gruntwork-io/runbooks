import { describe, it, expect, spyOn, beforeEach, afterAll } from "bun:test"
import * as fs from "node:fs"
import { Effect, Layer } from "effect"
import { runtime, sessionManager } from "./runtime.ts"
import {
  handleConfirmDetected,
  handleDetect,
  handleLoginPoll,
  handleLoginStart,
  handleSelectContext,
  handleServicePrincipal,
  handleValidateSession,
  resetAzureSignIns,
} from "./azure-signin.ts"
import { cleanupAzureConfigDirs } from "./azure-config-dirs.ts"
import { makeRecordingSpawner, type SpawnResponse } from "../../../src/test-utils/TestSpawner.ts"
import { makeTestEnvironment } from "../../../src/test-utils/TestEnvironment.ts"
import type { AzureSignInResultIpc } from "../../shared/channels.ts"

/**
 * The azure:* replies as the renderer receives them. The shared runtime runs
 * each effect against a fake `az` (a recording spawner answering by argv) and
 * a test process env; the domain functions, the config-dir custody and the
 * session manager are the real ones.
 */

const GUEST_TENANT = "05547fca-944c-4be0-9f4a-fac8b78fb1ab"
const HOME_TENANT = "141052b1-f3e4-49c2-91a3-dc349beb66f1"

const jwt = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`

const out = (
  text: string,
  source: "stdout" | "stderr" = "stdout",
  exitCode = 0,
): SpawnResponse => ({
  lines: text.split("\n").map((line) => ({ line, source })),
  exitCode,
})

interface FakeAz {
  accounts: unknown[]
  tenants: unknown[]
  token: Record<string, unknown>
  assignments: unknown[]
  loginFails?: string
}

let az: FakeAz
let processEnv: Record<string, string>
let spawner: ReturnType<typeof makeRecordingSpawner>

function respond(args: string[]): SpawnResponse {
  const cmd = args.slice(0, 3).join(" ")
  if (args[0] === "login") {
    if (az.loginFails) return out(`ERROR: ${az.loginFails}`, "stderr", 1)
    if (args.includes("--use-device-code")) {
      return out(
        "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD1234 to authenticate.",
        "stderr",
      )
    }
    return out("")
  }
  if (cmd.startsWith("account list")) return out(JSON.stringify(az.accounts))
  if (cmd.startsWith("account show")) {
    const def =
      (az.accounts as Array<{ isDefault?: boolean }>).find((a) => a.isDefault) ?? az.accounts[0]
    return def
      ? out(JSON.stringify(def))
      : out("ERROR: Please run 'az login' to setup account.", "stderr", 1)
  }
  if (cmd.startsWith("account set")) return out("")
  if (cmd.startsWith("account get-access-token")) return out(jwt(az.token))
  if (args[0] === "rest") return out(JSON.stringify({ value: az.tenants }))
  if (cmd.startsWith("role assignment list")) return out(JSON.stringify(az.assignments))
  return out(`ERROR: unexpected az ${args.join(" ")}`, "stderr", 2)
}

const runPromise = spyOn(runtime, "runPromise").mockImplementation((<A, E>(
  effect: Effect.Effect<A, E, never>,
) =>
  Effect.runPromise(
    Effect.provide(
      effect,
      Layer.merge(spawner.layer, makeTestEnvironment(processEnv)),
    ) as Effect.Effect<A, E>,
  )) as typeof runtime.runPromise)

afterAll(() => {
  runPromise.mockRestore()
  cleanupAzureConfigDirs()
  sessionManager.deleteSession()
})

const sessionEnv = () =>
  Effect.runSync(sessionManager.getSession().pipe(Effect.map((s) => Object.fromEntries(s.env))))

const authenticated = (result: unknown) => {
  const r = result as AzureSignInResultIpc
  if (r.status !== "authenticated")
    throw new Error(`expected authenticated, got ${JSON.stringify(r)}`)
  return r
}

beforeEach(() => {
  resetAzureSignIns()
  processEnv = { PATH: "/usr/bin" }
  spawner = makeRecordingSpawner((_command, args) => respond(args))
  az = {
    accounts: [{ id: "sub-1", name: "LZ Testing", tenantId: GUEST_TENANT, isDefault: true }],
    tenants: [{ tenantId: GUEST_TENANT, displayName: "LZ Testing" }],
    token: { oid: "user-oid", tid: GUEST_TENANT, upn: "alice@contoso.com" },
    assignments: [],
  }
  // A session another AzureAuth block (a CLI sign-in) already wrote to.
  Effect.runSync(
    sessionManager
      .createSession("/tmp")
      .pipe(
        Effect.provide(
          makeTestEnvironment({ ARM_USE_CLI: "true", AZURE_CONFIG_DIR: "/old", PATH: "/usr/bin" }),
        ),
      ),
  )
})

describe("azure:service-principal", () => {
  it("signs in to a dir of the block's own, and writes the session env", async () => {
    az.token = { oid: "sp-oid", tid: GUEST_TENANT, appid: "app-id", idtyp: "app" }
    const result = authenticated(
      await handleServicePrincipal({
        blockId: "sp",
        clientId: " app-id ",
        tenantId: GUEST_TENANT,
        clientSecret: "s3cret",
      }),
    )
    expect(result.principal.type).toBe("servicePrincipal")
    expect(result.subscriptionId).toBe("sub-1")
    expect(fs.existsSync(result.configDir)).toBe(true)
    expect(result.env.ARM_CLIENT_SECRET).toBe("s3cret")

    const env = sessionEnv()
    expect(env.AZURE_CONFIG_DIR).toBe(result.configDir)
    expect(env.ARM_CLIENT_ID).toBe("app-id")
    // The previous block's CLI flag would make azurerm skip the secret.
    expect(env.ARM_USE_CLI).toBeUndefined()

    const login = spawner.calls.find((call) => call.args[0] === "login")!
    expect(login.env?.AZURE_CONFIG_DIR).toBe(result.configDir)
    expect(login.args).toEqual(
      expect.arrayContaining(["--username", "app-id", "--tenant", GUEST_TENANT]),
    )
  })

  it("never echoes the secret, and releases the dir, when sign-in fails", async () => {
    az.loginFails = "AADSTS7000215: Invalid client secret provided."
    const result = await handleServicePrincipal({
      blockId: "sp",
      clientId: "app-id",
      tenantId: "t",
      clientSecret: "hunter2",
    })
    expect(result.status).toBe("failed")
    expect(JSON.stringify(result)).not.toContain("hunter2")
    const login = spawner.calls.find((call) => call.args[0] === "login")!
    expect(fs.existsSync(login.env!.AZURE_CONFIG_DIR!)).toBe(false)
    expect(sessionEnv().AZURE_CONFIG_DIR).toBe("/old")
  })

  it("needs a client ID and a tenant", async () => {
    expect(
      await handleServicePrincipal({
        blockId: "sp",
        clientId: "",
        tenantId: "t",
        clientSecret: "x",
      }),
    ).toEqual({ status: "failed", error: "A client ID and a tenant ID are required" })
    expect(spawner.calls).toHaveLength(0)
  })
})

describe("tenant and subscription choice", () => {
  it("asks a guest with several tenants to choose, then publishes the guest principal", async () => {
    az.accounts = [
      { id: "sub-home", name: "Home", tenantId: HOME_TENANT, isDefault: true },
      { id: "sub-1", name: "LZ Testing", tenantId: GUEST_TENANT },
    ]
    az.tenants = [
      { tenantId: HOME_TENANT, displayName: "Home" },
      { tenantId: GUEST_TENANT, displayName: "LZ Testing" },
    ]
    az.token = {
      oid: "guest-oid",
      tid: GUEST_TENANT,
      unique_name: "alice@contoso.com",
      idp: `https://sts.windows.net/${HOME_TENANT}/`,
    }

    const started = await handleLoginStart({ blockId: "lz", deviceCode: false })
    let polled = await handleLoginPoll({ flowId: started.flowId! })
    for (let i = 0; polled.status === "pending" && i < 50; i++) {
      await Bun.sleep(5)
      polled = await handleLoginPoll({ flowId: started.flowId! })
    }
    expect(polled.status).toBe("select_context")
    if (polled.status !== "select_context") return
    expect(polled.tenants.map((t) => t.tenantId)).toEqual([HOME_TENANT, GUEST_TENANT])
    expect(polled.subscriptions.map((s) => s.id)).toEqual(["sub-home", "sub-1"])

    const result = authenticated(
      await handleSelectContext({ blockId: "lz", tenantId: GUEST_TENANT, subscriptionId: "sub-1" }),
    )
    expect(result.principal).toMatchObject({
      type: "guest",
      homeTenantId: HOME_TENANT,
      objectId: "guest-oid",
    })
    expect(result.tenantName).toBe("LZ Testing")
    expect(result.authType).toBe("cli")
    expect(sessionEnv()).toMatchObject({
      ARM_TENANT_ID: GUEST_TENANT,
      ARM_SUBSCRIPTION_ID: "sub-1",
      ARM_USE_CLI: "true",
      AZURE_PRINCIPAL_TYPE: "guest",
    })
    const set = spawner.calls.find((call) => call.args[1] === "set")!
    expect(set.args).toEqual(expect.arrayContaining(["--subscription", "sub-1"]))
  })

  it("fails on missing required roles without touching the session", async () => {
    az.assignments = [{ roleDefinitionName: "Reader", scope: "/" }]
    const result = await handleServicePrincipal({
      blockId: "sp",
      clientId: "app",
      tenantId: GUEST_TENANT,
      clientSecret: "x",
      requiredRoles: [{ role: "Owner" }],
    })
    expect(result).toMatchObject({
      status: "failed",
      missingRoles: [{ role: "Owner", scope: "/subscriptions/sub-1" }],
    })
    expect(sessionEnv().AZURE_CONFIG_DIR).toBe("/old")
  })
})

describe("one sign-in per block", () => {
  it("gives two blocks separate dirs, and releases a block's old dir when it signs in again", async () => {
    const sp = { clientId: "app", tenantId: GUEST_TENANT, clientSecret: "x" }
    const a1 = authenticated(await handleServicePrincipal({ blockId: "a", ...sp }))
    const b = authenticated(await handleServicePrincipal({ blockId: "b", ...sp }))
    expect(a1.configDir).not.toBe(b.configDir)

    const a2 = authenticated(await handleServicePrincipal({ blockId: "a", ...sp }))
    expect(fs.existsSync(a1.configDir)).toBe(false)
    expect(fs.existsSync(a2.configDir)).toBe(true)
    expect(fs.existsSync(b.configDir)).toBe(true)
  })
})

describe("device code", () => {
  it("reports the code az printed, then signs in", async () => {
    // A controlled exit: the recording spawner's exit is immediate, so the
    // first poll may already see it. The code must still have been parsed.
    const started = await handleLoginStart({
      blockId: "dc",
      deviceCode: true,
      tenantId: GUEST_TENANT,
    })
    expect(started.flowId).toBeDefined()
    const login = spawner.calls.find((call) => call.args[0] === "login")!
    expect(login.args).toEqual(
      expect.arrayContaining(["--use-device-code", "--tenant", GUEST_TENANT]),
    )
    let polled = await handleLoginPoll({ flowId: started.flowId! })
    for (let i = 0; polled.status === "pending" && i < 50; i++) {
      await Bun.sleep(5)
      polled = await handleLoginPoll({ flowId: started.flowId! })
    }
    expect(authenticated(polled).authType).toBe("device_code")
  })

  it("says the flow is gone after it finished", async () => {
    expect(await handleLoginPoll({ flowId: "nope" })).toMatchObject({ status: "failed" })
  })
})

describe("detection", () => {
  it("reports an environment service principal from its names, without signing in", async () => {
    processEnv = {
      ...processEnv,
      CI_AZURE_CLIENT_ID: "app",
      CI_AZURE_TENANT_ID: "t",
      CI_AZURE_CLIENT_SECRET: "secret",
    }
    const detected = await handleDetect({ prefix: "CI_", sources: ["env"] })
    expect(detected).toEqual({
      found: true,
      source: "env",
      principalName: "app",
      tenantId: "t",
      envVarPrefix: "CI_AZURE_",
    })
    expect(JSON.stringify(detected)).not.toContain("secret")
    expect(spawner.calls).toHaveLength(0)
  })

  it("reports the user's own az login, read where az keeps it", async () => {
    processEnv = { ...processEnv, AZURE_CONFIG_DIR: "/home/me/.azure" }
    const detected = await handleDetect({ sources: ["cli"] })
    expect(detected).toMatchObject({
      found: true,
      source: "cli",
      principalName: "alice@contoso.com",
    })
    expect(spawner.calls[0]!.env?.AZURE_CONFIG_DIR).toBe("/home/me/.azure")
  })

  it("refuses an invalid prefix", async () => {
    expect((await handleDetect({ prefix: "a;b", sources: ["env"] })).found).toBe(false)
    expect(
      (await handleConfirmDetected({ blockId: "x", source: "env", prefix: "a;b" })).status,
    ).toBe("failed")
  })
})

describe("azure:validate-session", () => {
  it("refuses a dir main didn't create", async () => {
    expect(
      await handleValidateSession({ blockId: "x", configDir: "/home/me/.azure", tenantId: "t" }),
    ).toMatchObject({ valid: false })
    expect(spawner.calls).toHaveLength(0)
  })

  it("accepts a block's own dir that still gets a token", async () => {
    const result = authenticated(
      await handleServicePrincipal({
        blockId: "r",
        clientId: "a",
        tenantId: GUEST_TENANT,
        clientSecret: "x",
      }),
    )
    resetAzureSignIns()
    expect(
      await handleValidateSession({
        blockId: "r",
        configDir: result.configDir,
        tenantId: GUEST_TENANT,
      }),
    ).toEqual({ valid: true })
  })
})
