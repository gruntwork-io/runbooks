import { describe, it, expect } from "bun:test"
import YAML from "yaml"
import { parseDeclarations, parseInputLookups } from "./parse.ts"

const parse = (yaml: string, prefix: "" | "x-" = "") =>
  parseDeclarations(YAML.parse(yaml), "runbook_block.yml", prefix)

describe("parseDeclarations", () => {
  it("reads groups, lookups, checks and preflight", () => {
    const parsed = parse(`
lookups:
  aws:
    auth: AwsAuth
    groups:
      request:
        method: POST
        url: https://identitystore.{{ .auth.ssoRegion }}.amazonaws.com/
        headers: { X-Amz-Target: AWSIdentityStore.ListGroups }
        body: { IdentityStoreId: d-123 }
      rows: Groups
      next: { from: NextToken, to: body.NextToken }
      fields: { value: DisplayName, description: Description }
checks:
  google:
    auth: GoogleAuth
    scopes: [https://www.googleapis.com/auth/cloud-platform]
    apiEnabled:
      params: [api]
      request: { url: "https://serviceusage.googleapis.com/v1/projects/{{ .auth.project }}/services/{{ .params.api }}" }
      expect: { path: state, equals: ENABLED }
      message: "{{ .params.api }} is off."
preflight:
  - check: google.apiEnabled
    with: { api: admin.googleapis.com }
`)
    expect(parsed.problems).toEqual([])
    expect(parsed.groups.map((g) => [g.name, g.auth])).toEqual([
      ["aws", "AwsAuth"],
      ["google", "GoogleAuth"],
    ])
    expect(parsed.lookups[0]).toMatchObject({
      id: "aws.groups",
      maxPages: 10,
      rows: "Groups",
      next: { from: "NextToken", to: "body.NextToken" },
      request: { method: "POST" },
    })
    expect(parsed.checks[0]).toMatchObject({
      id: "google.apiEnabled",
      params: ["api"],
      expect: { path: "state", equals: "ENABLED" },
      request: { method: "GET" },
    })
    expect(parsed.preflight).toEqual([
      { from: "google.apiEnabled", with: { api: "admin.googleapis.com" } },
    ])
  })

  it("reads x- keys from a boilerplate.yml", () => {
    const parsed = parse(
      `
x-lookups:
  google:
    auth: GoogleAuth
    me:
      request: { url: https://admin.googleapis.com/admin/directory/v1/users/me }
      fields: { email: primaryEmail }
`,
      "x-",
    )
    expect(parsed.problems).toEqual([])
    expect(parsed.lookups.map((l) => l.id)).toEqual(["google.me"])
  })

  it("reports each malformed declaration", () => {
    const messages = parse(`
lookups:
  linear:
    auth: LinearAuth
    teams: {}
  aws:
    auth: AwsAuth
    noFields:
      request: { url: https://iam.amazonaws.com/ }
    getWithBody:
      request: { url: https://iam.amazonaws.com/, body: {} }
      fields: { value: x }
    tooManyPages:
      request: { url: https://iam.amazonaws.com/ }
      fields: { value: x }
      maxPages: 51
    badNext:
      request: { url: https://iam.amazonaws.com/ }
      fields: { value: x }
      next: { from: Marker, to: body.Marker }
checks:
  aws:
    auth: AwsAuth
    twoConditions:
      request: { url: https://iam.amazonaws.com/ }
      expect: { path: x, equals: a, exists: true }
      message: m
`).problems.map((p) => p.message)
    expect(messages).toEqual([
      expect.stringContaining("lookups.linear.auth must name the kind of auth block"),
      expect.stringContaining("Lookup aws.noFields must declare its fields"),
      expect.stringContaining("is a GET, which has no body"),
      expect.stringContaining("maxPages must be a whole number from 1 to 50"),
      expect.stringContaining("a GET has no body, so next.to must be query.<name>"),
      expect.stringContaining("expect must be { path, equals }"),
    ])
  })
})

describe("parseInputLookups", () => {
  it("reads a variable's lookup, prefill and shortcut", () => {
    const parsed = parseInputLookups(
      {
        lookup: { from: "google.people" },
        prefill: { from: "google.customer" },
        shortcut: { from: "google.me", label: "Use my email" },
      },
      "variables.owners",
      "runbook_block.yml",
    )
    expect(parsed.problems).toEqual([])
    expect(parsed.lookups).toEqual({
      lookup: { from: "google.people", with: {} },
      prefill: { from: "google.customer", with: {} },
      shortcut: { from: "google.me", with: {}, label: "Use my email" },
    })
  })
})
