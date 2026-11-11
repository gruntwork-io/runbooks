import { describe, it, expect } from "bun:test"
import YAML from "yaml"
import { parseDeclarations } from "./parse.ts"
import { sampleCheckResponse, sampleLookupResponse } from "./record.ts"

const parsed = parseDeclarations(
  YAML.parse(`
lookups:
  google:
    auth: GoogleAuth
    people:
      request: { url: https://admin.googleapis.com/u }
      rows: users
      next: { from: nextPageToken, to: query.pageToken }
      fields: { value: primaryEmail, label: name.fullName }
checks:
  google:
    auth: GoogleAuth
    enabled:
      request: { url: https://serviceusage.googleapis.com/s }
      expect: { path: state, equals: ENABLED }
      message: off
`),
  "runbook_block.yml",
)
const people = parsed.lookups[0]!
const enabled = parsed.checks[0]!

const RESPONSE = {
  kind: "admin#directory#users",
  nextPageToken: "secret-token",
  users: [1, 2, 3, 4].map((n) => ({
    primaryEmail: `real${n}@acme.com`,
    name: { fullName: `Real Person ${n}`, givenName: "Real" },
    isAdmin: n === 1,
  })),
}

describe("sampleLookupResponse", () => {
  it("keeps three rows and only the paths the lookup reads, with placeholders", () => {
    expect(sampleLookupResponse(people, RESPONSE, { keepValues: false })).toEqual({
      users: [1, 2, 3].map((n) => ({
        primaryEmail: `user-${n}@example.com`,
        name: { fullName: `label-${n}` },
      })),
    })
  })

  it("keeps the real values when asked", () => {
    const sample = sampleLookupResponse(people, RESPONSE, { keepValues: true }) as {
      users: unknown[]
    }
    expect(sample.users[0]).toEqual({
      primaryEmail: "real1@acme.com",
      name: { fullName: "Real Person 1" },
    })
  })
})

describe("sampleCheckResponse", () => {
  it("keeps the value an equals check compares, and nothing else", () => {
    expect(
      sampleCheckResponse(
        enabled,
        { state: "ENABLED", name: "projects/123" },
        { keepValues: false },
      ),
    ).toEqual({
      state: "ENABLED",
    })
  })
})
