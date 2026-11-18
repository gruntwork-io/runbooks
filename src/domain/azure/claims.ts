/**
 * Who an Azure access token belongs to, read from its claims.
 *
 * The token comes from `az account get-access-token`, run in the block's own
 * config dir, so it is never verified here: it is our own credential, and the
 * claims only label it. The token itself never leaves main.
 *
 * Pure: no imports with I/O.
 */

/** What kind of principal signed in. */
export type AzurePrincipalType = "user" | "guest" | "servicePrincipal"

/** The signed-in principal, as AzureAuth publishes it. */
export interface AzurePrincipal {
  /** UPN (or sign-in name) for a user or guest; the app (client) ID for a service principal. */
  readonly name: string
  readonly objectId: string
  readonly type: AzurePrincipalType
  /** The tenant the token was issued for. */
  readonly tenantId: string
  /** A guest's home tenant, when the token names it. */
  readonly homeTenantId?: string
  /** A display name, when the token carries one. */
  readonly displayName?: string
}

type Claims = Record<string, unknown>

/** The payload of a JWT, or undefined when `token` isn't one. */
export function decodeJwtPayload(token: string): Claims | undefined {
  const parts = token.split(".")
  if (parts.length < 2 || !parts[1]) return undefined
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8")
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === "object" ? (parsed as Claims) : undefined
  } catch {
    return undefined
  }
}

const str = (claims: Claims, key: string): string | undefined => {
  const value = claims[key]
  return typeof value === "string" && value !== "" ? value : undefined
}

/** The tenant ID in an STS issuer URL such as `https://sts.windows.net/<tid>/`. */
function tenantOfIssuer(issuer: string | undefined): string | undefined {
  if (!issuer) return undefined
  const match =
    /^https:\/\/(?:sts\.windows\.net|login\.microsoftonline\.com)\/([0-9a-f-]{36})(?:\/|$)/i.exec(
      issuer,
    )
  return match?.[1]?.toLowerCase()
}

/**
 * The principal an access token's claims describe, or undefined when they
 * don't name one (no `oid`, or no `tid`).
 *
 * A guest is a user whose identity provider (`idp`) is another tenant (B2B), or
 * a Microsoft account (`live.com`). A member's token has no `idp`, or one that
 * is its own tenant. `homeTenantId` in the Azure CLI profile can't tell them
 * apart: it records the tenant `az login --tenant` named, which for a guest is
 * the guest tenant. A `#EXT#` UPN is the same signal from the directory, for
 * tokens without `idp`.
 */
export function principalFromClaims(claims: Claims): AzurePrincipal | undefined {
  const objectId = str(claims, "oid")
  const tenantId = str(claims, "tid")?.toLowerCase()
  if (!objectId || !tenantId) return undefined

  const displayName = str(claims, "name")
  const appId = str(claims, "appid") ?? str(claims, "azp")
  const isApp =
    str(claims, "idtyp") === "app" ||
    (!str(claims, "upn") && !str(claims, "unique_name") && !str(claims, "preferred_username"))

  if (isApp) {
    return {
      name: appId ?? objectId,
      objectId,
      type: "servicePrincipal",
      tenantId,
      ...(displayName ? { displayName } : {}),
    }
  }

  const name =
    str(claims, "upn") ??
    str(claims, "unique_name") ??
    str(claims, "preferred_username") ??
    str(claims, "email") ??
    objectId

  const idp = str(claims, "idp")
  const idpTenant = tenantOfIssuer(idp)
  const externalIdp = idp !== undefined && idpTenant !== tenantId
  const guest = externalIdp || /#EXT#@/i.test(name) || str(claims, "acct") === "1"

  return {
    name,
    objectId,
    type: guest ? "guest" : "user",
    tenantId,
    ...(guest && idpTenant ? { homeTenantId: idpTenant } : {}),
    ...(displayName ? { displayName } : {}),
  }
}
