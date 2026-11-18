/**
 * Azure sign-in for AzureAuth, through the Azure CLI.
 *
 * Every call takes the block's config dir (see ./cli.ts). Interactive sign-in
 * (browser and device code) is a long-running `az login` that main keeps in a
 * flow registry; this module builds its arguments and reads what it prints.
 */
import { Effect } from "effect"
import { Environment } from "../../services/Environment.ts"
import { AzureAuthError } from "../../errors/index.ts"
import { ENV_PREFIX_PATTERN } from "../env-prefix.ts"
import { runAz, runAzJson, type AzContext } from "./cli.ts"
import { decodeJwtPayload, principalFromClaims, type AzurePrincipal } from "./claims.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One entry of `az account list`: a subscription, or a tenant with none. */
export interface AzureSubscription {
  readonly id: string
  readonly name: string
  readonly tenantId: string
  readonly state?: string
  readonly isDefault: boolean
  /**
   * `az login --allow-no-subscriptions` lists a tenant without subscriptions
   * as an entry whose id is the tenant's. It has no subscription to pick.
   */
  readonly tenantLevel: boolean
}

export interface AzureTenant {
  readonly tenantId: string
  readonly displayName?: string
  readonly defaultDomain?: string
}

/** Where the sign-in is pointed: a tenant, and a subscription in it when it has one. */
export interface AzureContextChoice {
  readonly tenantId: string
  readonly subscriptionId?: string
}

/** The tenants and subscriptions a sign-in can use, and what (if anything) is already chosen. */
export interface AzureContextOptions {
  readonly tenants: readonly AzureTenant[]
  /** Real subscriptions only; tenant-level entries are left out. */
  readonly subscriptions: readonly AzureSubscription[]
  /** Set when the block's pins, or there being only one option, decide the context. */
  readonly chosen?: AzureContextChoice
}

/** A service principal sign-in. Exactly one of secret or certificate. */
export interface ServicePrincipalCredentials {
  readonly clientId: string
  readonly tenantId: string
  readonly clientSecret?: string | undefined
  readonly certificatePath?: string | undefined
}

/** A role an author requires, at a scope. */
export interface RequiredRole {
  readonly role: string
  /**
   * An ARM scope such as `/` or `/subscriptions/<id>`, or `subscription` for
   * the chosen subscription. Defaults to `subscription`.
   */
  readonly scope?: string
}

/** A required role the principal doesn't have. */
export interface MissingRole {
  readonly role: string
  readonly scope: string
}

// ---------------------------------------------------------------------------
// Account and token
// ---------------------------------------------------------------------------

interface RawAccount {
  id?: string
  name?: string
  tenantId?: string
  state?: string
  isDefault?: boolean
}

/** az's name for a tenant with no subscriptions. */
const TENANT_LEVEL_NAME = /^N\/A\(tenant level account\)$/

const toSubscription = (raw: RawAccount): AzureSubscription | undefined => {
  if (!raw.id || !raw.tenantId) return undefined
  const tenantLevel = TENANT_LEVEL_NAME.test(raw.name ?? "") || raw.id === raw.tenantId
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    tenantId: raw.tenantId.toLowerCase(),
    ...(raw.state ? { state: raw.state } : {}),
    isDefault: raw.isDefault === true,
    tenantLevel,
  }
}

/** `az` errors that mean "nobody is signed in here", as opposed to a failure. */
const NOT_SIGNED_IN =
  /az login|no subscription found|not logged in|AADSTS700082|refresh token has expired/i

/** The account `az` would use in `ctx`, or undefined when nobody is signed in there. */
export const showAccount = (ctx: AzContext) =>
  runAzJson<RawAccount>(ctx, ["account", "show"]).pipe(
    Effect.map((raw) => (raw ? toSubscription(raw) : undefined)),
    Effect.catchIf(
      (err) => !err.cliMissing && NOT_SIGNED_IN.test(err.message),
      () => Effect.succeed(undefined),
    ),
  )

/** Every subscription (and subscription-less tenant) the sign-in in `ctx` found. */
export const listAccounts = (ctx: AzContext) =>
  runAzJson<RawAccount[]>(ctx, ["account", "list", "--all"]).pipe(
    Effect.map((raws) =>
      (raws ?? []).flatMap((raw) => {
        const sub = toSubscription(raw)
        return sub ? [sub] : []
      }),
    ),
  )

/**
 * The tenants the signed-in account belongs to, member or guest, from ARM's
 * `/tenants` (az 2.6x+ moved `az account tenant list` to an extension).
 * Inconclusive answers come back empty: the picker then falls back to the
 * tenants `az account list` names.
 */
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
                ...(tenant.displayName ? { displayName: tenant.displayName } : {}),
                ...(tenant.defaultDomain ? { defaultDomain: tenant.defaultDomain } : {}),
              },
            ]
          : [],
      ),
    ),
    Effect.catch(() => Effect.succeed([] as AzureTenant[])),
  )

/**
 * Who is signed in to `tenantId` in `ctx`, read from an ARM access token's
 * claims. Fails when no token can be had for that tenant without the user,
 * which for a guest tenant usually means MFA or a Conditional Access policy:
 * the message says to sign in to that tenant directly.
 */
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

/** Make `subscriptionId` the default in `ctx`, so a bare `az` uses it. */
export const setSubscription = (ctx: AzContext, subscriptionId: string) =>
  runAz(ctx, ["account", "set", "--subscription", subscriptionId], {
    display: "az account set",
  }).pipe(Effect.asVoid)

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

/** The `az login` arguments for an interactive (browser) or device-code sign-in. */
export function interactiveLoginArgs(deviceCode: boolean, tenantId?: string): string[] {
  const args = ["login", "--allow-no-subscriptions", "--only-show-errors", "-o", "none"]
  if (deviceCode) args.push("--use-device-code")
  if (tenantId) args.push("--tenant", tenantId)
  return args
}

/** What `az login --use-device-code` tells the user to do. */
export interface DeviceCodePrompt {
  readonly verificationUri: string
  readonly userCode: string
}

/**
 * The URL and code in az's device-code message: "To sign in, use a web browser
 * to open the page https://microsoft.com/devicelogin and enter the code
 * ABCD1234 to authenticate."
 */
export function parseDeviceCodePrompt(line: string): DeviceCodePrompt | undefined {
  const uri = /https:\/\/\S+/.exec(line)?.[0]?.replace(/[.,;:]+$/, "")
  const code = /\bcode\s+([A-Z0-9-]{6,})\b/i.exec(line)?.[1]
  if (!uri || !code) return undefined
  return { verificationUri: uri, userCode: code }
}

/**
 * Sign a service principal in to `ctx`. The secret goes on az's command line,
 * the only way az takes one non-interactively; it is never echoed in errors.
 */
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
    if (creds.clientSecret) {
      args.push(`--password=${creds.clientSecret}`)
    } else if (creds.certificatePath) {
      args.push("--certificate", creds.certificatePath)
    } else {
      return yield* new AzureAuthError({
        message: "A client secret or a certificate is required",
      })
    }
    yield* runAz(ctx, args, { display: "az login --service-principal" })
  })

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

/** A service principal found in the environment. Never handed to the renderer. */
export interface EnvServicePrincipal extends ServicePrincipalCredentials {
  /** Which family of names supplied it. */
  readonly envVarPrefix: "ARM_" | "AZURE_"
  readonly subscriptionId?: string
}

/**
 * A service principal in ARM_* (OpenTofu/Terraform's names), then AZURE_*
 * (the Azure SDKs' names): a client ID, a tenant ID and a secret or a
 * certificate path. With `prefix`, every name is looked up with it prepended.
 * The prefix must already be allowlist-checked in main; an invalid one finds
 * nothing.
 */
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
      if (clientId && tenantId && (clientSecret || certificatePath)) {
        const subscriptionId = yield* get("SUBSCRIPTION_ID")
        return {
          envVarPrefix: family,
          clientId,
          tenantId,
          ...(clientSecret ? { clientSecret } : { certificatePath }),
          ...(subscriptionId ? { subscriptionId } : {}),
        } satisfies EnvServicePrincipal
      }
    }
    return undefined
  })

// ---------------------------------------------------------------------------
// Tenant and subscription choice
// ---------------------------------------------------------------------------

/**
 * Work out the tenants and subscriptions to offer, and whether the block's
 * pins (or there being one option) already decide the context.
 *
 * - A pinned subscription decides the tenant too; it must be among the
 *   sign-in's subscriptions (in the pinned tenant, when both are pinned).
 * - A pinned tenant narrows the subscriptions to it. With one subscription
 *   it's chosen; with none the context is the tenant alone, for tenant-level
 *   work such as bootstrapping a landing zone.
 * - Without pins, one tenant with at most one subscription is chosen;
 *   anything else is the user's to pick.
 */
export function resolveContextOptions(params: {
  readonly accounts: readonly AzureSubscription[]
  readonly tenants: readonly AzureTenant[]
  readonly signedInTenantId?: string
  readonly tenantId?: string
  readonly subscriptionId?: string
}): Effect.Effect<AzureContextOptions, AzureAuthError> {
  const pinnedTenant = params.tenantId?.toLowerCase()
  const subscriptions = params.accounts.filter((account) => !account.tenantLevel)

  // Every tenant the sign-in can see: ARM's list, plus any `az account list`
  // names that it lacks, plus the one the token is for.
  const tenantIds = new Set<string>()
  const tenants: AzureTenant[] = []
  const addTenant = (tenant: AzureTenant) => {
    if (tenantIds.has(tenant.tenantId)) return
    tenantIds.add(tenant.tenantId)
    tenants.push(tenant)
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
      return Effect.fail(
        new AzureAuthError({
          message: pinnedTenant
            ? `Subscription ${params.subscriptionId} isn't one this account can use in tenant ${params.tenantId}`
            : `Subscription ${params.subscriptionId} isn't one this account can use`,
        }),
      )
    }
    return Effect.succeed({
      tenants,
      subscriptions,
      chosen: { tenantId: match.tenantId, subscriptionId: match.id },
    })
  }

  if (pinnedTenant) {
    const inTenant = subscriptions.filter((sub) => sub.tenantId === pinnedTenant)
    if (!tenantIds.has(pinnedTenant)) {
      return Effect.fail(
        new AzureAuthError({
          message: `This account can't see tenant ${params.tenantId}. Sign in to that tenant directly, or ask its admin to invite you.`,
        }),
      )
    }
    if (inTenant.length <= 1) {
      return Effect.succeed({
        tenants,
        subscriptions,
        chosen: {
          tenantId: pinnedTenant,
          ...(inTenant[0] ? { subscriptionId: inTenant[0].id } : {}),
        },
      })
    }
    return Effect.succeed({ tenants, subscriptions })
  }

  if (tenants.length === 1 && subscriptions.length <= 1) {
    return Effect.succeed({
      tenants,
      subscriptions,
      chosen: {
        tenantId: tenants[0]!.tenantId,
        ...(subscriptions[0] ? { subscriptionId: subscriptions[0].id } : {}),
      },
    })
  }
  return Effect.succeed({ tenants, subscriptions })
}

// ---------------------------------------------------------------------------
// Required roles
// ---------------------------------------------------------------------------

/** The ARM scope a required role names, with `subscription` resolved. */
export function resolveRoleScope(scope: string | undefined, subscriptionId?: string): string {
  const raw = (scope ?? "subscription").trim()
  if (raw === "subscription" || raw === "") {
    return subscriptionId ? `/subscriptions/${subscriptionId}` : "/"
  }
  return raw.startsWith("/") ? raw : `/${raw}`
}

/** Whether an assignment at `assignedScope` reaches `scope` (it, or a parent of it). */
export function scopeCovers(assignedScope: string, scope: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\/+$/, "") || "/"
  const assigned = norm(assignedScope)
  const wanted = norm(scope)
  if (assigned === "/") return true
  return wanted === assigned || wanted.startsWith(`${assigned}/`)
}

interface RawAssignment {
  roleDefinitionName?: string
  scope?: string
}

/** The required roles none of `assignments` grants. */
export function missingRoles(
  required: readonly RequiredRole[],
  assignments: readonly RawAssignment[],
  subscriptionId?: string,
): MissingRole[] {
  return required.flatMap((req) => {
    const scope = resolveRoleScope(req.scope, subscriptionId)
    const granted = assignments.some(
      (assignment) =>
        assignment.roleDefinitionName?.toLowerCase() === req.role.toLowerCase() &&
        assignment.scope !== undefined &&
        scopeCovers(assignment.scope, scope),
    )
    return granted ? [] : [{ role: req.role, scope }]
  })
}

/**
 * The role assignments `principal` has at `scope` or above it, its groups'
 * included. Listing groups needs Microsoft Graph, which a guest often can't
 * read; then it falls back to the principal's own assignments.
 */
const assignmentsAt = (ctx: AzContext, objectId: string, scope: string) =>
  runAzJson<RawAssignment[]>(
    ctx,
    [
      "role",
      "assignment",
      "list",
      "--assignee",
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
    Effect.catch(() =>
      runAzJson<RawAssignment[]>(
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
          "--fill-principal-name",
          "false",
        ],
        { display: "az role assignment list" },
      ),
    ),
    Effect.map((list) => list ?? []),
  )

/**
 * Check that `principal` holds every required role. Returns the ones it
 * lacks; fails only when the assignments can't be read at all.
 */
export const checkRequiredRoles = (
  ctx: AzContext,
  principal: AzurePrincipal,
  required: readonly RequiredRole[],
  subscriptionId?: string,
) =>
  Effect.gen(function* () {
    if (required.length === 0) return [] as MissingRole[]
    const scopes = [...new Set(required.map((req) => resolveRoleScope(req.scope, subscriptionId)))]
    const assignments: RawAssignment[] = []
    for (const scope of scopes) {
      assignments.push(...(yield* assignmentsAt(ctx, principal.objectId, scope)))
    }
    return missingRoles(required, assignments, subscriptionId)
  })

/** The actionable sentence for missing roles. */
export function missingRolesMessage(
  missing: readonly MissingRole[],
  principalName: string,
): string {
  const list = missing.map((m) => `${m.role} at ${m.scope}`).join(", ")
  const elevate = missing.some((m) => m.scope === "/" && /user access administrator/i.test(m.role))
    ? ' For User Access Administrator at /, a Global Administrator can turn on "Access management for Azure resources" in Entra ID > Properties, then sign in again.'
    : ""
  return `${principalName} is missing the required role${missing.length > 1 ? "s" : ""}: ${list}. Ask an administrator to assign ${missing.length > 1 ? "them" : "it"}, then sign in again.${elevate}`
}
