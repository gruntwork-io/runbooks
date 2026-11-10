/**
 * The lookups a <TfModule> block's runbook_block.yml can name, and the rows each
 * gives, in the shape the module's templates read. The main process answers
 * them from Google with the account a GoogleAuth block signed in, or from
 * simulation.yml in simulation mode, so both must give rows of these shapes.
 */
import type { GoogleDomain, GooglePerson } from "../../services/GoogleClient.ts"
import type { LookupRow } from "./rowTemplate.ts"

export const LOOKUPS = {
  "google.me": "the signed-in account: email, name",
  "google.domains": "the organization's domains: domainName, isPrimary",
  "google.people": "active users in the organization: value (email), label (name), description",
} as const

export type LookupName = keyof typeof LOOKUPS

export const isLookupName = (from: string): from is LookupName => Object.hasOwn(LOOKUPS, from)

/** Whether a row has a value containing what the user typed, ignoring case. */
export function matchesQuery(row: LookupRow, query: string): boolean {
  if (query === "") return true
  const needle = query.toLowerCase()
  return Object.values(row).some(
    (value) =>
      (typeof value === "string" || typeof value === "number") &&
      String(value).toLowerCase().includes(needle),
  )
}

export const meRows = (email: string): LookupRow[] => [{ email, name: email }]

/** The domains, primary first, as the rows google.domains gives. */
export function domainRows(domains: readonly GoogleDomain[]): LookupRow[] {
  return [...domains]
    .sort(
      (a, b) =>
        Number(b.isPrimary) - Number(a.isPrimary) || a.domainName.localeCompare(b.domainName),
    )
    .map((d) => ({ value: d.domainName, domainName: d.domainName, isPrimary: d.isPrimary }))
}

export function personRows(people: readonly GooglePerson[]): LookupRow[] {
  return people.map((p) => ({
    value: p.email,
    label: p.name ?? p.email,
    ...(p.title ? { description: p.title } : {}),
  }))
}
