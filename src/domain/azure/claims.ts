export interface AzurePrincipal {
  readonly name: string
  readonly objectId: string
  readonly type: "user" | "guest" | "servicePrincipal"
  readonly tenantId: string
  readonly homeTenantId?: string | undefined
  readonly displayName?: string | undefined
}

type Claims = Record<string, unknown>

export function decodeJwtPayload(token: string): Claims | undefined {
  const payload = token.split(".")[1]
  if (!payload) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return parsed && typeof parsed === "object" ? (parsed as Claims) : undefined
  } catch {
    return undefined
  }
}

const str = (claims: Claims, key: string): string | undefined => {
  const value = claims[key]
  return typeof value === "string" && value !== "" ? value : undefined
}

const tenantOfIssuer = (issuer: string | undefined): string | undefined =>
  issuer
    ? /^https:\/\/(?:sts\.windows\.net|login\.microsoftonline\.com)\/([0-9a-f-]{36})(?:\/|$)/i
        .exec(issuer)?.[1]
        ?.toLowerCase()
    : undefined

export function principalFromClaims(claims: Claims): AzurePrincipal | undefined {
  const objectId = str(claims, "oid")
  const tenantId = str(claims, "tid")?.toLowerCase()
  if (!objectId || !tenantId) return undefined

  const displayName = str(claims, "name")
  const userName =
    str(claims, "upn") ?? str(claims, "unique_name") ?? str(claims, "preferred_username")

  if (str(claims, "idtyp") === "app" || !userName) {
    return {
      name: str(claims, "appid") ?? str(claims, "azp") ?? objectId,
      objectId,
      type: "servicePrincipal",
      tenantId,
      displayName,
    }
  }

  const idp = str(claims, "idp")
  const idpTenant = tenantOfIssuer(idp)
  const guest =
    (idp !== undefined && idpTenant !== tenantId) ||
    /#EXT#@/i.test(userName) ||
    str(claims, "acct") === "1"

  return {
    name: userName,
    objectId,
    type: guest ? "guest" : "user",
    tenantId,
    homeTenantId: guest ? idpTenant : undefined,
    displayName,
  }
}
