/**
 * The Directory API's `users.list` queries that find people as they're typed:
 * by the start of a first name, last name, or email address. One query can't
 * say "or", so a single word becomes one query per field, and two or more
 * words match a first name and a last name. Suspended users are left out.
 */
export function userSearchQueries(typed: string): string[] {
  const active = "isSuspended=false"
  // Keeps only characters a prefix match can take, so typed text can't change the query.
  const words = typed
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}._@+-]/gu, ""))
    .filter(Boolean)
  const [first, ...rest] = words
  if (!first) return [active]
  if (rest.length === 0) {
    return [`givenName:${first}*`, `familyName:${first}*`, `email:${first}*`].map(
      (clause) => `${clause} ${active}`,
    )
  }
  return [`givenName:${first}* familyName:${rest.join(" ")}* ${active}`]
}
