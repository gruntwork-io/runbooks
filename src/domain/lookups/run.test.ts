import { describe, it, expect } from "bun:test"
import YAML from "yaml"
import { parseDeclarations } from "./parse.ts"
import { mergeDeclarations } from "./validate.ts"
import { inputsRead, readsQuery, runCheck, runLookup, type RunContext } from "./run.ts"
import type { HttpReply, HttpRequest } from "../../services/HttpRequest.ts"

const definitionsOf = (yaml: string) =>
  mergeDeclarations(parseDeclarations(YAML.parse(yaml), "runbook_block.yml"), []).definitions

/** A context whose send answers each request with the next reply, recording what was sent. */
function contextFor(yaml: string, replies: (request: HttpRequest) => unknown) {
  const sent: HttpRequest[] = []
  const context: RunContext = {
    definitions: definitionsOf(yaml),
    inputs: { name: "a b/c", domain: "example.com" },
    auth: () => ({ ssoRegion: "us-east-2", project: "my-project" }),
    send: async (request) => {
      sent.push(request)
      const reply = replies(request)
      if (reply && typeof reply === "object" && "status" in reply) return reply as HttpReply
      return { status: 200, contentType: "application/json", body: JSON.stringify(reply) }
    },
  }
  return { context, sent }
}

const AWS = `
lookups:
  aws:
    auth: AwsAuth
    identityStore:
      request:
        method: POST
        url: https://sso.{{ .auth.ssoRegion }}.amazonaws.com/
        headers: { X-Amz-Target: SWBExternalService.ListInstances }
        body: {}
      rows: Instances
      fields: { identityStoreId: IdentityStoreId }
    groups:
      request:
        method: POST
        url: https://identitystore.{{ .auth.ssoRegion }}.amazonaws.com/
        headers: { X-Amz-Target: AWSIdentityStore.ListGroups, Content-Type: application/x-amz-json-1.1 }
        body: { IdentityStoreId: "{{ .lookups.aws.identityStore.identityStoreId }}" }
      rows: Groups
      next: { from: NextToken, to: body.NextToken }
      maxPages: 3
      fields: { value: DisplayName, description: Description }
`

describe("runLookup", () => {
  it("chains from a one-row lookup, pages until the token runs out, and keeps only declared fields", async () => {
    const { context, sent } = contextFor(AWS, (request) => {
      if (request.url.startsWith("https://sso."))
        return { Instances: [{ IdentityStoreId: "d-123", Other: 1 }] }
      const body = JSON.parse(request.body ?? "{}") as { NextToken?: string }
      return body.NextToken
        ? { Groups: [{ DisplayName: "Admins" }] }
        : {
            Groups: [{ DisplayName: "Devs", Description: "Engineers", GroupId: "g-1" }],
            NextToken: "t1",
          }
    })
    const result = await runLookup(context, { from: "aws.groups", with: {} })
    expect(result).toEqual({
      rows: [{ value: "Devs", description: "Engineers" }, { value: "Admins" }],
      capped: false,
    })
    expect(sent.map((r) => [r.url, r.body])).toEqual([
      ["https://sso.us-east-2.amazonaws.com/", "{}"],
      ["https://identitystore.us-east-2.amazonaws.com/", '{"IdentityStoreId":"d-123"}'],
      [
        "https://identitystore.us-east-2.amazonaws.com/",
        '{"IdentityStoreId":"d-123","NextToken":"t1"}',
      ],
    ])
    expect(sent[1]?.headers).toEqual({
      "x-amz-target": "AWSIdentityStore.ListGroups",
      "content-type": "application/x-amz-json-1.1",
    })
  })

  it("stops at maxPages and says so", async () => {
    let n = 0
    const { context } = contextFor(AWS, (request) =>
      request.url.startsWith("https://sso.")
        ? { Instances: [{ IdentityStoreId: "d-123" }] }
        : { Groups: [{ DisplayName: `g${n}` }], NextToken: `t${++n}` },
    )
    const result = await runLookup(context, { from: "aws.groups", with: {} })
    expect(result.capped).toBe(true)
    expect(result.rows).toHaveLength(3)
  })

  it("stops when the API repeats a token", async () => {
    const { context, sent } = contextFor(AWS, (request) =>
      request.url.startsWith("https://sso.")
        ? { Instances: [{ IdentityStoreId: "d-123" }] }
        : { Groups: [], NextToken: "same" },
    )
    expect((await runLookup(context, { from: "aws.groups", with: {} })).capped).toBe(false)
    expect(sent).toHaveLength(3)
  })

  it("refuses to chain from a lookup that doesn't give exactly one row", async () => {
    const { context } = contextFor(AWS, () => ({
      Instances: [{ IdentityStoreId: "a" }, { IdentityStoreId: "b" }],
    }))
    await expect(runLookup(context, { from: "aws.groups", with: {} })).rejects.toThrow(
      "aws.groups reads a value from aws.identityStore, which must give exactly one row. It gave 2.",
    )
  })

  it("encodes each value for where it goes", async () => {
    const { context, sent } = contextFor(
      `
lookups:
  google:
    auth: GoogleAuth
    people:
      request:
        url: "https://admin.googleapis.com/admin/directory/v1/users/{{ .inputs.name }}?query={{ .query }}&domain={{ .inputs.domain }}"
      rows: users
      fields: { value: primaryEmail }
`,
      () => ({ users: [{ primaryEmail: "a@example.com" }] }),
    )
    await runLookup(context, { from: "google.people", with: {} }, "x&y=1")
    expect(sent[0]?.url).toBe(
      "https://admin.googleapis.com/admin/directory/v1/users/a%20b%2Fc?query=x%26y%3D1&domain=example.com",
    )
  })

  it("keeps typed text a string inside a JSON body", async () => {
    const { context, sent } = contextFor(
      `
lookups:
  aws:
    auth: AwsAuth
    search:
      request:
        method: POST
        url: https://identitystore.us-east-2.amazonaws.com/
        headers: { X-Amz-Target: AWSIdentityStore.ListUsers }
        body: { Filters: [{ AttributeValue: "{{ .query }}" }] }
      rows: Users
      fields: { value: UserName }
`,
      () => ({ Users: [] }),
    )
    await runLookup(context, { from: "aws.search", with: {} }, '", "Injected": "1')
    expect(JSON.parse(sent[0]?.body ?? "")).toEqual({
      Filters: [{ AttributeValue: '", "Injected": "1' }],
    })
  })

  it("explains an error answer and a row missing a field", async () => {
    const lookup = `
lookups:
  google:
    auth: GoogleAuth
    domains:
      request: { url: https://admin.googleapis.com/admin/directory/v1/customer/my_customer/domains }
      rows: domains
      fields: { value: domainName }
`
    const denied = contextFor(lookup, () => ({
      status: 403,
      contentType: "application/json",
      body: '{"error":"denied"}',
    }))
    await expect(runLookup(denied.context, { from: "google.domains", with: {} })).rejects.toThrow(
      'google.domains: admin.googleapis.com answered 403: {"error":"denied"}',
    )
    const drifted = contextFor(lookup, () => ({ domains: [{ name: "example.com" }] }))
    await expect(runLookup(drifted.context, { from: "google.domains", with: {} })).rejects.toThrow(
      "a row has no domainName, which field value reads. The row's keys are name.",
    )
  })

  it("knows which lookups run again as the user types", () => {
    const definitions = definitionsOf(`
lookups:
  google:
    auth: GoogleAuth
    people:
      request: { url: "https://admin.googleapis.com/u?query={{ .query }}" }
      fields: { value: id }
    domains:
      request: { url: https://admin.googleapis.com/d }
      fields: { value: id }
`)
    expect(readsQuery(definitions.lookups["google.people"]!)).toBe(true)
    expect(readsQuery(definitions.lookups["google.domains"]!)).toBe(false)
  })
})

describe("runCheck", () => {
  const CHECK = `
checks:
  google:
    auth: GoogleAuth
    apiEnabled:
      params: [api]
      request: { url: "https://serviceusage.googleapis.com/v1/projects/{{ .auth.project }}/services/{{ .params.api }}" }
      expect: { path: state, equals: ENABLED }
      message: "{{ .params.api }} is off in {{ .auth.project }}."
      fix: "https://console.cloud.google.com/apis/library/{{ .params.api }}"
`
  const use = { from: "google.apiEnabled", with: { api: "admin.googleapis.com" } }

  it("passes when the answer meets the expectation", async () => {
    const { context, sent } = contextFor(CHECK, () => ({ state: "ENABLED" }))
    expect(await runCheck(context, use)).toEqual({ outcome: "passed" })
    expect(sent[0]?.url).toBe(
      "https://serviceusage.googleapis.com/v1/projects/my-project/services/admin.googleapis.com",
    )
  })

  it("tells send which check a request is for, with the use's params", async () => {
    const { context } = contextFor(CHECK, () => ({ state: "ENABLED" }))
    const about: unknown[] = []
    const send = context.send
    await runCheck(
      {
        ...context,
        send: (request, group, auth, sendFor) => {
          about.push(sendFor)
          return send(request, group, auth, sendFor)
        },
      },
      use,
    )
    expect(about).toEqual([{ id: "google.apiEnabled", with: { api: "admin.googleapis.com" } }])
  })

  it("fails with its message and fix when the answer doesn't", async () => {
    const { context } = contextFor(CHECK, () => ({ state: "DISABLED" }))
    expect(await runCheck(context, use)).toEqual({
      outcome: "failed",
      message: "admin.googleapis.com is off in my-project.",
      fix: "https://console.cloud.google.com/apis/library/admin.googleapis.com",
    })
  })

  it("can't tell, and never shows its message, on an error answer or a missing field", async () => {
    const denied = contextFor(CHECK, () => ({
      status: 403,
      contentType: "",
      body: "PERMISSION_DENIED",
    }))
    expect(await runCheck(denied.context, use)).toEqual({
      outcome: "unknown",
      detail: "google.apiEnabled: serviceusage.googleapis.com answered 403: PERMISSION_DENIED",
    })
    const empty = contextFor(CHECK, () => ({}))
    expect(await runCheck(empty.context, use)).toEqual({
      outcome: "unknown",
      detail: "The response has no state.",
    })
  })
})

describe("inputsRead", () => {
  it("names the inputs a use reads through its params, its request and its chain", () => {
    const definitions = definitionsOf(`
lookups:
  aws:
    auth: AwsAuth
    store:
      request:
        url: "https://sso.{{ .auth.ssoRegion }}.amazonaws.com/?Action=ListInstances&Owner={{ .inputs.owner }}"
      fields: { value: IdentityStoreId }
    groups:
      params: [prefix]
      request:
        method: POST
        url: https://identitystore.us-east-1.amazonaws.com/
        body:
          IdentityStoreId: "{{ .lookups.aws.store.value }}"
          Filter: "{{ .inputs.team }}"
      fields: { value: DisplayName }
`)
    expect(
      inputsRead(definitions, { from: "aws.groups", with: { prefix: "{{ .inputs.name }}" } }),
    ).toEqual(["name", "owner", "team"])
  })
})
