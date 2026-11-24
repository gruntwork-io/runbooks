import { describe, it, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import {
  checkRequiredRoles,
  detectEnvServicePrincipal,
  interactiveLoginArgs,
  listAccounts,
  listTenants,
  loginServicePrincipal,
  missingRolesMessage,
  needsInteraction,
  parseDeviceCodePrompt,
  principalFor,
  refreshSubscriptions,
  resolveContextOptions,
  resolveRoleScope,
  showAccount,
  type AzureSubscription,
} from "./auth.ts"
import { AZ_MISSING_MESSAGE, azCommand } from "./cli.ts"
import type { AzureAuthError } from "../../errors/index.ts"
import { makeRecordingSpawner, type SpawnResponse } from "../../test-utils/TestSpawner.ts"
import { makeTestEnvironment } from "../../test-utils/TestEnvironment.ts"

const CTX = { configDir: "/tmp/runbooks-azure-test" }

const stdout = (text: string, exitCode = 0): SpawnResponse => ({
  lines: text.split("\n").map((line) => ({ line, source: "stdout" as const })),
  exitCode,
})
const stderr = (text: string, exitCode = 1): SpawnResponse => ({
  lines: text.split("\n").map((line) => ({ line, source: "stderr" as const })),
  exitCode,
})

function run<A, E>(
  effect: Effect.Effect<A, E, any>,
  respond: (args: string[]) => SpawnResponse | "ENOENT",
  env: Record<string, string> = { PATH: "/usr/bin", AZURE_CONFIG_DIR: "/home/me/.azure" },
) {
  const spawner = makeRecordingSpawner((_command, args) => respond(args))
  const layer = Layer.mergeAll(spawner.layer, makeTestEnvironment(env))
  return {
    exit: Effect.runSyncExit(Effect.provide(effect, layer) as Effect.Effect<A, E>),
    calls: spawner.calls,
  }
}

const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value
  throw new Error(`expected success, got ${JSON.stringify(exit.cause)}`)
}
const failureMessage = <A, E>(exit: Exit.Exit<A, E>): string => {
  if (Exit.isSuccess(exit)) throw new Error("expected failure")
  return JSON.stringify(exit.cause)
}

const jwt = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`

describe("running az", () => {
  it("runs in the block's config dir, not the user's, with prompts off", () => {
    const { calls } = run(showAccount(CTX), () => stdout("{}"))
    expect(calls[0]!.command).toBe("az")
    expect(calls[0]!.env?.AZURE_CONFIG_DIR).toBe("/tmp/runbooks-azure-test")
    expect(calls[0]!.env?.AZURE_CORE_LOGIN_EXPERIENCE_V2).toBe("off")
    expect(calls[0]!.env?.PATH).toBe("/usr/bin")
  })

  it("says how to install az when it's missing", () => {
    const { exit } = run(showAccount(CTX), () => "ENOENT")
    expect(failureMessage(exit)).toContain(AZ_MISSING_MESSAGE)
  })
})

describe("showAccount", () => {
  it("returns undefined when nobody is signed in", () => {
    const { exit } = run(showAccount(CTX), () =>
      stderr("WARNING: something\nERROR: Please run 'az login' to setup account."),
    )
    expect(value(exit)).toBeUndefined()
  })

  it("fails on any other error, with az's error line", () => {
    const { exit } = run(showAccount(CTX), () =>
      stderr("SyntaxWarning: invalid escape\nERROR: the network is down"),
    )
    expect(failureMessage(exit)).toContain("the network is down")
  })
})

describe("listAccounts", () => {
  it("marks a tenant with no subscriptions as tenant-level, and drops disabled ones", () => {
    const { exit } = run(listAccounts(CTX), () =>
      stdout(
        JSON.stringify([
          { id: "sub-1", name: "Prod", tenantId: "T1", isDefault: true, state: "Enabled" },
          { id: "t2", name: "N/A(tenant level account)", tenantId: "t2" },
          { id: "old", name: "Old", tenantId: "T1", state: "Disabled" },
        ]),
      ),
    )
    expect(value(exit)).toEqual([
      {
        id: "sub-1",
        name: "Prod",
        tenantId: "t1",
        isDefault: true,
        tenantLevel: false,
      },
      {
        id: "t2",
        name: "N/A(tenant level account)",
        tenantId: "t2",
        isDefault: false,
        tenantLevel: true,
      },
    ])
  })
})

describe("listTenants", () => {
  it("reads ARM's /tenants", () => {
    const { exit, calls } = run(listTenants(CTX), () =>
      stdout(
        JSON.stringify({
          value: [{ tenantId: "T1", displayName: "Home", defaultDomain: "h.com" }],
        }),
      ),
    )
    expect(value(exit)).toEqual([{ tenantId: "t1", displayName: "Home", defaultDomain: "h.com" }])
    expect(calls[0]!.args).toContain("rest")
  })

  it("comes back empty rather than failing", () => {
    const { exit } = run(listTenants(CTX), () => stderr("ERROR: Forbidden"))
    expect(value(exit)).toEqual([])
  })
})

describe("principalFor", () => {
  it("reads a guest from the token for the guest tenant", () => {
    const token = jwt({
      oid: "o",
      tid: "guest-tenant",
      unique_name: "me@home.com",
      idp: "https://sts.windows.net/11111111-1111-1111-1111-111111111111/",
    })
    const { exit, calls } = run(principalFor(CTX, "guest-tenant"), () => stdout(token))
    expect(value(exit).type).toBe("guest")
    expect(calls[0]!.args).toEqual([
      "account",
      "get-access-token",
      "--query",
      "accessToken",
      "-o",
      "tsv",
      "--tenant",
      "guest-tenant",
    ])
  })

  it("says to sign in to the tenant when no token comes silently", () => {
    const { exit } = run(principalFor(CTX, "t9"), () =>
      stderr("ERROR: AADSTS50020: User account from identity provider does not exist in tenant"),
    )
    expect(failureMessage(exit)).toContain("Sign in with that tenant ID")
    expect(failureMessage(exit)).not.toContain("interactionRequired")
  })

  it("marks a tenant that wants an interactive sign-in, without its AADSTS text", () => {
    const { exit } = run(principalFor(CTX, "t9"), () =>
      stderr(
        "ERROR: AADSTS50076: Due to a configuration change made by your administrator, you must use multi-factor authentication to access 't9'.",
      ),
    )
    if (Exit.isSuccess(exit)) throw new Error("expected failure")
    const error = Cause.squash(exit.cause) as AzureAuthError
    expect(error.interactionRequired).toBe(true)
    expect(error.message).toBe("Tenant t9 needs you to sign in to it again")
  })
})

describe("needsInteraction", () => {
  it.each([
    "AADSTS50076: Due to a configuration change made by your administrator",
    "AADSTS50079: Due to a configuration change made by your administrator, you must enroll",
    "AADSTS50158: External security challenge not satisfied",
    "AADSTS65001: The user or administrator has not consented to use the application",
    "Interactive authentication is needed. Please run: az login --tenant t9",
  ])("is true for %s", (message) => {
    expect(needsInteraction(message)).toBe(true)
  })

  it.each([
    "AADSTS50020: User account from identity provider does not exist in tenant",
    "AADSTS53003: Access has been blocked by Conditional Access policies",
    "AADSTS500761 is not a code",
    "Max retries exceeded with url",
  ])("is false for %s", (message) => {
    expect(needsInteraction(message)).toBe(false)
  })
})

describe("loginServicePrincipal", () => {
  it("sends the secret on stdin, never in argv or the error", () => {
    const { exit, calls } = run(
      loginServicePrincipal(CTX, { clientId: "app", tenantId: "t", clientSecret: "hunter2" }),
      () => stderr("ERROR: AADSTS7000215: Invalid client secret provided."),
    )
    const message = failureMessage(exit)
    expect(message).toContain("Invalid client secret")
    expect(message).not.toContain("hunter2")
    expect(calls[0]!.args).toContain("--password=@-")
    expect(calls[0]!.args.join(" ")).not.toContain("hunter2")
    expect(calls[0]!.stdin).toBe("hunter2")
    expect(calls[0]!.args).toContain("--allow-no-subscriptions")
  })

  it("takes a certificate path", () => {
    const { calls } = run(
      loginServicePrincipal(CTX, { clientId: "app", tenantId: "t", certificatePath: "/k.pem" }),
      () => stdout(""),
    )
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["--certificate", "/k.pem"]))
  })

  it("refuses a PKCS#12 certificate, which az can't read", () => {
    const { exit, calls } = run(
      loginServicePrincipal(CTX, { clientId: "app", tenantId: "t", certificatePath: "/k.pfx" }),
      () => stdout(""),
    )
    expect(failureMessage(exit)).toContain("PEM certificate")
    expect(calls).toHaveLength(0)
  })

  it("needs a secret or a certificate", () => {
    const { exit, calls } = run(
      loginServicePrincipal(CTX, { clientId: "app", tenantId: "t" }),
      () => stdout(""),
    )
    expect(failureMessage(exit)).toContain("client secret or a certificate")
    expect(calls).toHaveLength(0)
  })
})

describe("interactive sign-in", () => {
  it("builds az login arguments", () => {
    expect(interactiveLoginArgs(false)).toEqual([
      "login",
      "--allow-no-subscriptions",
      "--only-show-errors",
      "-o",
      "none",
    ])
    expect(interactiveLoginArgs(true, "t1")).toEqual(
      expect.arrayContaining(["--use-device-code", "--tenant", "t1"]),
    )
  })

  it("reads the device code message", () => {
    expect(
      parseDeviceCodePrompt(
        "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD12345 to authenticate.",
      ),
    ).toEqual({ verificationUri: "https://microsoft.com/devicelogin", userCode: "ABCD12345" })
    expect(parseDeviceCodePrompt("WARNING: nothing to see")).toBeUndefined()
  })
})

describe("detectEnvServicePrincipal", () => {
  const detect = (env: Record<string, string>, prefix?: string) =>
    Effect.runSync(detectEnvServicePrincipal(prefix).pipe(Effect.provide(makeTestEnvironment(env))))

  it("prefers ARM_* to AZURE_*", () => {
    expect(
      detect({
        ARM_CLIENT_ID: "a",
        ARM_TENANT_ID: "t",
        ARM_CLIENT_SECRET: "s",
        ARM_SUBSCRIPTION_ID: "sub",
        AZURE_CLIENT_ID: "b",
        AZURE_TENANT_ID: "t",
        AZURE_CLIENT_SECRET: "s2",
      }),
    ).toEqual({
      envVarPrefix: "ARM_",
      clientId: "a",
      tenantId: "t",
      clientSecret: "s",
      subscriptionId: "sub",
    })
  })

  it("needs a client ID, a tenant and a secret or certificate", () => {
    expect(detect({ AZURE_CLIENT_ID: "a", AZURE_TENANT_ID: "t" })).toBeUndefined()
    expect(
      detect({
        AZURE_CLIENT_ID: "a",
        AZURE_TENANT_ID: "t",
        AZURE_CLIENT_CERTIFICATE_PATH: "/c.pem",
      }),
    ).toEqual({ envVarPrefix: "AZURE_", clientId: "a", tenantId: "t", certificatePath: "/c.pem" })
  })

  it("reads prefixed names only, and ignores an invalid prefix", () => {
    const env = { CI_ARM_CLIENT_ID: "a", CI_ARM_TENANT_ID: "t", CI_ARM_CLIENT_SECRET: "s" }
    expect(detect(env, "CI_")?.clientId).toBe("a")
    expect(detect(env)).toBeUndefined()
    expect(detect({ ...env, "BAD;ARM_CLIENT_ID": "x" }, "BAD;")).toBeUndefined()
  })
})

describe("resolveContextOptions", () => {
  const sub = (id: string, tenantId: string, name = id): AzureSubscription => ({
    id,
    name,
    tenantId,
    isDefault: false,
    tenantLevel: false,
  })
  const tenantLevel = (tenantId: string): AzureSubscription => ({
    id: tenantId,
    name: "N/A(tenant level account)",
    tenantId,
    isDefault: false,
    tenantLevel: true,
  })
  const resolve = (params: Parameters<typeof resolveContextOptions>[0]) =>
    Effect.runSyncExit(Effect.try({ try: () => resolveContextOptions(params), catch: (e) => e }))

  it("chooses the only tenant and subscription", () => {
    expect(value(resolve({ accounts: [sub("s1", "t1")], tenants: [] })).chosen).toEqual({
      tenantId: "t1",
      subscriptionId: "s1",
    })
  })

  it("leaves several subscriptions to the user", () => {
    const options = value(resolve({ accounts: [sub("s1", "t1"), sub("s2", "t1")], tenants: [] }))
    expect(options.chosen).toBeUndefined()
    expect(options.subscriptions.map((s) => s.id)).toEqual(["s1", "s2"])
  })

  it("chooses a pinned subscription by ID or name, and its tenant", () => {
    const accounts = [sub("s1", "t1", "Prod"), sub("s2", "t2", "Dev")]
    expect(value(resolve({ accounts, tenants: [], subscriptionId: "Dev" })).chosen).toEqual({
      tenantId: "t2",
      subscriptionId: "s2",
    })
  })

  it("refuses a pinned subscription the account can't use", () => {
    expect(
      failureMessage(resolve({ accounts: [sub("s1", "t1")], tenants: [], subscriptionId: "s9" })),
    ).toContain("isn't one this account can use")
  })

  it("chooses a pinned tenant with no subscriptions for tenant-level work", () => {
    expect(
      value(
        resolve({ accounts: [tenantLevel("t2"), sub("s1", "t1")], tenants: [], tenantId: "T2" }),
      ).chosen,
    ).toEqual({ tenantId: "t2" })
  })

  it("refuses a pinned tenant the account can't see", () => {
    expect(
      failureMessage(resolve({ accounts: [sub("s1", "t1")], tenants: [], tenantId: "t9" })),
    ).toContain("can't see tenant t9")
  })

  it("offers every tenant from ARM, the profile and the token", () => {
    const options = value(
      resolve({
        accounts: [sub("s1", "t1")],
        tenants: [
          { tenantId: "t1", displayName: "Home" },
          { tenantId: "t2", displayName: "Guest" },
        ],
        signedInTenantId: "t3",
      }),
    )
    expect(options.tenants.map((t) => t.tenantId)).toEqual(["t1", "t2", "t3"])
    expect(options.chosen).toBeUndefined()
  })
})

describe("required roles", () => {
  const principal = { name: "me", objectId: "oid", type: "guest" as const, tenantId: "t" }

  it("resolves the subscription shorthand", () => {
    expect(resolveRoleScope(undefined, "s1")).toBe("/subscriptions/s1")
    expect(resolveRoleScope("subscription")).toBeUndefined()
    expect(resolveRoleScope("/")).toBe("/")
    expect(resolveRoleScope("providers/Microsoft.Management/managementGroups/mg")).toBe(
      "/providers/Microsoft.Management/managementGroups/mg",
    )
  })

  it("counts a role inherited from a management group, with groups, in one call per scope", () => {
    const { exit, calls } = run(
      checkRequiredRoles(
        CTX,
        principal,
        [
          { role: "owner" },
          { role: "Contributor" },
          { role: "User Access Administrator", scope: "/" },
        ],
        "s1",
      ),
      (args) =>
        args.includes("/subscriptions/s1")
          ? stdout(
              JSON.stringify([
                {
                  roleDefinitionName: "Owner",
                  scope: "/providers/Microsoft.Management/managementGroups/root",
                },
              ]),
            )
          : stdout(JSON.stringify([{ roleDefinitionName: "Reader", scope: "/" }])),
    )
    expect(value(exit)).toEqual([
      { role: "Contributor", scope: "/subscriptions/s1" },
      { role: "User Access Administrator", scope: "/" },
    ])
    expect(calls).toHaveLength(2)
    expect(calls[0]!.args).toEqual(
      expect.arrayContaining([
        "--assignee-object-id",
        "oid",
        "--include-groups",
        "--include-inherited",
      ]),
    )
  })

  it("reports a subscription role as missing when no subscription was chosen", () => {
    const { exit, calls } = run(checkRequiredRoles(CTX, principal, [{ role: "Owner" }]), () =>
      stdout("[]"),
    )
    expect(value(exit)).toEqual([{ role: "Owner", scope: "the subscription (none chosen)" }])
    expect(calls).toHaveLength(0)
  })

  it("explains how to get User Access Administrator at the root", () => {
    expect(
      missingRolesMessage([{ role: "User Access Administrator", scope: "/" }], "me@x.com"),
    ).toContain("Access management for Azure resources")
  })
})

describe("azCommand", () => {
  it("runs az directly, or through cmd.exe on Windows with every argument quoted", () => {
    expect(azCommand(["account", "show"], "linux")).toEqual({
      command: "az",
      args: ["account", "show"],
    })
    expect(azCommand(["login", "--certificate", 'C:\\My Keys\\a"b.pem'], "win32")).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '""az" "login" "--certificate" "C:\\My Keys\\a""b.pem""'],
      windowsVerbatimArguments: true,
    })
  })
})

describe("refreshSubscriptions", () => {
  it("refreshes the subscriptions in the block's config dir", () => {
    const { exit, calls } = run(refreshSubscriptions(CTX), () => stdout(""))
    value(exit)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toEqual(["account", "list", "--refresh", "-o", "none"])
    expect(calls[0]!.env!.AZURE_CONFIG_DIR).toBe(CTX.configDir)
  })

  it("fails when az does", () => {
    const { exit } = run(refreshSubscriptions(CTX), () => stderr("ERROR: network unreachable"))
    expect(failureMessage(exit)).toContain("network unreachable")
  })
})
