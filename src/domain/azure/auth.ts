import { Effect } from "effect"
import { Environment } from "../../services/Environment.ts"
import { AzureAuthError } from "../../errors/index.ts"
import { ENV_PREFIX_PATTERN } from "../env-prefix.ts"
import { runAz, runAzJson, type AzContext } from "./cli.ts"
import { decodeJwtPayload, principalFromClaims } from "./claims.ts"
import type { AzurePrincipal } from "./claims.ts"

export interface AzureSubscription {
  readonly id: string
  readonly name: string
  readonly tenantId: string
  readonly isDefault: boolean
  readonly tenantLevel: boolean
}

export interface AzureTenant {
  readonly tenantId: string
  readonly displayName?: string | undefined
  readonly defaultDomain?: string | undefined
}

interface AzureContextChoice {
  readonly tenantId: string
  readonly subscriptionId?: string
}

interface AzureContextOptions {
  readonly tenants: readonly AzureTenant[]
  readonly subscriptions: readonly AzureSubscription[]
  readonly chosen?: AzureContextChoice
}

interface ServicePrincipalCredentials {
  readonly clientId: string
  readonly tenantId: string
  readonly clientSecret?: string | undefined
  readonly certificatePath?: string | undefined
}

export interface RequiredRole {
  readonly role: string
  readonly scope?: string | undefined
}

interface MissingRole {
  readonly role: string
  readonly scope: string
}

interface RawAccount {
  id?: string
  name?: string
  tenantId?: string
  state?: string
  isDefault?: boolean
}

const TENANT_LEVEL_NAME = /^N\/A\(tenant level account\)$/

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isTenantGuid = (tenant: string) => GUID.test(tenant)

const toSubscription = (raw: RawAccount): AzureSubscription | undefined => {
  if (!raw.id || !raw.tenantId || raw.state === "Disabled") return undefined
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    tenantId: raw.tenantId.toLowerCase(),
    isDefault: raw.isDefault === true,
    tenantLevel: TENANT_LEVEL_NAME.test(raw.name ?? "") || raw.id === raw.tenantId,
  }
}

const NOT_SIGNED_IN =
  /az login|no subscription found|not logged in|AADSTS700082|refresh token has expired/i

export const showAccount = (ctx: AzContext) =>
  runAzJson<RawAccount>(ctx, ["account", "show"]).pipe(
    Effect.map((raw) => (raw ? toSubscription(raw) : undefined)),
    Effect.catchIf(
      (err) => !err.cliMissing && NOT_SIGNED_IN.test(err.message),
      () => Effect.succeed(undefined),
    ),
  )

export const listAccounts = (ctx: AzContext) =>
  runAzJson<RawAccount[]>(ctx, ["account", "list", "--all"]).pipe(
    Effect.map((raws) => (raws ?? []).flatMap((raw) => toSubscription(raw) ?? [])),
  )

export const listTenants = (ctx: AzContext) =>
  runAzJson<{ value?: Array<{ tenantId?: string; displayName?: string; defaultDomain?: string }> }>(
    ctx,
    [
      "rest",
      "--method",
      "get",
      "--url",
      "https://management.azure.com/tenants?api-version=2022-12-01",
    ],
    { display: "az rest /tenants" },
  ).pipe(
    Effect.map((body) =>
      (body?.value ?? []).flatMap((tenant): AzureTenant[] =>
        tenant.tenantId
          ? [
              {
                tenantId: tenant.tenantId.toLowerCase(),
                displayName: tenant.displayName,
                defaultDomain: tenant.defaultDomain,
              },
            ]
          : [],
      ),
    ),
    Effect.catch(() => Effect.succeed([] as AzureTenant[])),
  )

export const principalFor = (ctx: AzContext, tenantId?: string) =>
  Effect.gen(function* () {
    const args = ["account", "get-access-token", "--query", "accessToken", "-o", "tsv"]
    if (tenantId) args.push("--tenant", tenantId)
    const token = (yield* runAz(ctx, args, { display: "az account get-access-token" }).pipe(
      Effect.mapError((err) =>
        tenantId && !err.cliMissing
          ? new AzureAuthError({
              message: `Couldn't get a token for tenant ${tenantId} without signing in again (${err.message}). Sign in with that tenant ID.`,
              command: err.command,
            })
          : err,
      ),
    )).trim()
    const claims = decodeJwtPayload(token)
    const principal = claims ? principalFromClaims(claims) : undefined
    if (!principal) {
      return yield* new AzureAuthError({
        message: "The Azure CLI's token doesn't say who is signed in",
      })
    }
    return principal
  })

export const setSubscription = (ctx: AzContext, subscriptionId: string) =>
  runAz(ctx, ["account", "set", "--subscription", subscriptionId], {
    display: "az account set",
  }).pipe(Effect.asVoid)

/**
 * Fetch the account's subscriptions again (`az account list --refresh`), so a
 * config dir copied from the user's az login lists subscriptions created
 * since that login. az keeps the default subscription while it is still
 * listed.
 */
export const refreshSubscriptions = (ctx: AzContext) =>
  runAz(ctx, ["account", "list", "--refresh", "-o", "none"], {
    display: "az account list --refresh",
  }).pipe(Effect.asVoid)

export function interactiveLoginArgs(deviceCode: boolean, tenantId?: string): string[] {
  const args = ["login", "--allow-no-subscriptions", "--only-show-errors", "-o", "none"]
  if (deviceCode) args.push("--use-device-code")
  if (tenantId) args.push("--tenant", tenantId)
  return args
}

export interface DeviceCodePrompt {
  readonly verificationUri: string
  readonly userCode: string
}

export function parseDeviceCodePrompt(line: string): DeviceCodePrompt | undefined {
  const uri = /https:\/\/\S+/.exec(line)?.[0]?.replace(/[.,;:]+$/, "")
  const code = /\bcode\s+([A-Z0-9-]{6,})\b/i.exec(line)?.[1]
  if (!uri || !code) return undefined
  return { verificationUri: uri, userCode: code }
}

const isPkcs12 = (path: string) => /\.(pfx|p12)$/i.test(path)

export const loginServicePrincipal = (ctx: AzContext, creds: ServicePrincipalCredentials) =>
  Effect.gen(function* () {
    if (!creds.clientId || !creds.tenantId) {
      return yield* new AzureAuthError({ message: "A client ID and a tenant ID are required" })
    }
    const args = [
      "login",
      "--service-principal",
      "--username",
      creds.clientId,
      "--tenant",
      creds.tenantId,
      "--allow-no-subscriptions",
      "-o",
      "none",
    ]
    const display = "az login --service-principal"
    if (creds.clientSecret) {
      yield* runAz(ctx, [...args, "--password=@-"], { display, stdin: creds.clientSecret })
    } else if (creds.certificatePath) {
      if (isPkcs12(creds.certificatePath)) {
        return yield* new AzureAuthError({
          message: `The Azure CLI takes a PEM certificate, not ${creds.certificatePath}. Convert it with openssl pkcs12 -in <file> -out <file>.pem -nodes.`,
        })
      }
      yield* runAz(ctx, [...args, "--certificate", creds.certificatePath], { display })
    } else {
      return yield* new AzureAuthError({ message: "A client secret or a certificate is required" })
    }
  })

export interface EnvServicePrincipal extends ServicePrincipalCredentials {
  readonly envVarPrefix: "ARM_" | "AZURE_"
  readonly subscriptionId?: string
}

export const detectEnvServicePrincipal = (prefix?: string) =>
  Effect.gen(function* () {
    if (prefix && !ENV_PREFIX_PATTERN.test(prefix)) return undefined
    const env = yield* Environment
    const p = prefix ?? ""
    for (const family of ["ARM_", "AZURE_"] as const) {
      const get = (name: string) => env.get(`${p}${family}${name}`)
      const clientId = yield* get("CLIENT_ID")
      const tenantId = yield* get("TENANT_ID")
      const clientSecret = yield* get("CLIENT_SECRET")
      const certificatePath = yield* get("CLIENT_CERTIFICATE_PATH")
      const usableCertificate =
        certificatePath && !isPkcs12(certificatePath) ? certificatePath : undefined
      if (clientId && tenantId && (clientSecret || usableCertificate)) {
        const subscriptionId = yield* get("SUBSCRIPTION_ID")
        return {
          envVarPrefix: family,
          clientId,
          tenantId,
          ...(clientSecret ? { clientSecret } : { certificatePath: usableCertificate }),
          ...(subscriptionId ? { subscriptionId } : {}),
        } satisfies EnvServicePrincipal
      }
    }
    return undefined
  })

export function resolveContextOptions(params: {
  readonly accounts: readonly AzureSubscription[]
  readonly tenants: readonly AzureTenant[]
  readonly signedInTenantId?: string | undefined
  readonly tenantId?: string | undefined
  readonly subscriptionId?: string | undefined
}): AzureContextOptions {
  const pinnedTenant = params.tenantId?.toLowerCase()
  const subscriptions = params.accounts.filter((account) => !account.tenantLevel)

  const tenants: AzureTenant[] = []
  const addTenant = (tenant: AzureTenant) => {
    if (!tenants.some((t) => t.tenantId === tenant.tenantId)) tenants.push(tenant)
  }
  for (const tenant of params.tenants) addTenant(tenant)
  for (const account of params.accounts) addTenant({ tenantId: account.tenantId })
  if (params.signedInTenantId) addTenant({ tenantId: params.signedInTenantId.toLowerCase() })

  if (params.subscriptionId) {
    const wanted = params.subscriptionId.toLowerCase()
    const match = subscriptions.find(
      (sub) =>
        (sub.id.toLowerCase() === wanted || sub.name.toLowerCase() === wanted) &&
        (!pinnedTenant || sub.tenantId === pinnedTenant),
    )
    if (!match) {
      throw new AzureAuthError({
        message: pinnedTenant
          ? `Subscription ${params.subscriptionId} isn't one this account can use in tenant ${params.tenantId}`
          : `Subscription ${params.subscriptionId} isn't one this account can use`,
      })
    }
    return {
      tenants,
      subscriptions,
      chosen: { tenantId: match.tenantId, subscriptionId: match.id },
    }
  }

  if (pinnedTenant) {
    if (!tenants.some((t) => t.tenantId === pinnedTenant)) {
      throw new AzureAuthError({
        message: `This account can't see tenant ${params.tenantId}. Sign in to that tenant directly, or ask its admin to invite you.`,
      })
    }
    const inTenant = subscriptions.filter((sub) => sub.tenantId === pinnedTenant)
    if (inTenant.length > 1) return { tenants, subscriptions }
    return {
      tenants,
      subscriptions,
      chosen: {
        tenantId: pinnedTenant,
        ...(inTenant[0] ? { subscriptionId: inTenant[0].id } : {}),
      },
    }
  }

  if (tenants.length === 1 && subscriptions.length <= 1) {
    return {
      tenants,
      subscriptions,
      chosen: {
        tenantId: tenants[0]!.tenantId,
        ...(subscriptions[0] ? { subscriptionId: subscriptions[0].id } : {}),
      },
    }
  }
  return { tenants, subscriptions }
}

export function resolveRoleScope(
  scope: string | undefined,
  subscriptionId?: string,
): string | undefined {
  const raw = (scope ?? "subscription").trim()
  if (raw === "subscription" || raw === "") {
    return subscriptionId ? `/subscriptions/${subscriptionId}` : undefined
  }
  return raw.startsWith("/") ? raw : `/${raw}`
}

const rolesAt = (ctx: AzContext, objectId: string, scope: string) =>
  runAzJson<Array<{ roleDefinitionName?: string }>>(
    ctx,
    [
      "role",
      "assignment",
      "list",
      "--assignee-object-id",
      objectId,
      "--scope",
      scope,
      "--include-inherited",
      "--include-groups",
      "--fill-principal-name",
      "false",
    ],
    { display: "az role assignment list" },
  ).pipe(
    Effect.map(
      (list) =>
        new Set(
          (list ?? []).flatMap((assignment) => assignment.roleDefinitionName?.toLowerCase() ?? []),
        ),
    ),
  )

export const checkRequiredRoles = (
  ctx: AzContext,
  principal: AzurePrincipal,
  required: readonly RequiredRole[],
  subscriptionId?: string,
) =>
  Effect.gen(function* () {
    const missing: MissingRole[] = []
    const byScope = new Map<string, Set<string>>()
    for (const req of required) {
      const scope = resolveRoleScope(req.scope, subscriptionId)
      if (!scope) {
        missing.push({ role: req.role, scope: "the subscription (none chosen)" })
        continue
      }
      let roles = byScope.get(scope)
      if (!roles) {
        roles = yield* rolesAt(ctx, principal.objectId, scope)
        byScope.set(scope, roles)
      }
      if (!roles.has(req.role.toLowerCase())) missing.push({ role: req.role, scope })
    }
    return missing
  })

export function missingRolesMessage(
  missing: readonly MissingRole[],
  principalName: string,
): string {
  const list = missing.map((m) => `${m.role} at ${m.scope}`).join(", ")
  const elevate = missing.some((m) => m.scope === "/" && /user access administrator/i.test(m.role))
    ? ' For User Access Administrator at /, a Global Administrator can turn on "Access management for Azure resources" in Entra ID > Properties, then sign in again.'
    : ""
  const plural = missing.length > 1
  return `${principalName} is missing the required role${plural ? "s" : ""}: ${list}. Ask an administrator to assign ${plural ? "them" : "it"}, then sign in again.${elevate}`
}
