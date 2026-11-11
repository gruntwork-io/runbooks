import { describe, it, expect } from "bun:test"
import YAML from "yaml"
import { parseDeclarations } from "./parse.ts"
import { bindingProblems, checkDefinitions, mergeDeclarations, usedGroups } from "./validate.ts"
import type { Use } from "./types.ts"

const load = (yaml: string, include?: string) => {
  const own = parseDeclarations(YAML.parse(yaml), "runbook_block.yml")
  const includes = include ? [parseDeclarations(YAML.parse(include), "_includes/shared.yml")] : []
  return mergeDeclarations(own, includes)
}

const problemsOf = (yaml: string, uses: { where: string; use: Use }[] = [], inputs?: string[]) => {
  const merged = load(yaml)
  return [
    ...merged.problems,
    ...checkDefinitions(merged.definitions, {
      lookups: uses,
      preflight: merged.preflight,
      inputs,
      source: "runbook_block.yml",
    }),
  ].map((p) => p.message)
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
        headers: { X-Amz-Target: AWSIdentityStore.ListGroups }
        body: { IdentityStoreId: "{{ .lookups.aws.identityStore.identityStoreId }}" }
      rows: Groups
      fields: { value: DisplayName }
`

describe("checkDefinitions", () => {
  it("accepts a chained lookup and its uses", () => {
    expect(
      problemsOf(AWS, [{ where: "variables.group.lookup", use: { from: "aws.groups", with: {} } }]),
    ).toEqual([])
  })

  it("rejects a template in the URL's host that a form value could pick", () => {
    expect(
      problemsOf(`
lookups:
  aws:
    auth: AwsAuth
    x:
      request: { url: "https://{{ .inputs.host }}/path" }
      fields: { value: id }
`),
    ).toEqual([
      expect.stringContaining("a URL's scheme and host can use only literal text and .auth"),
    ])
  })

  it("rejects a template inside a GraphQL query", () => {
    expect(
      problemsOf(`
lookups:
  google:
    auth: GoogleAuth
    teams:
      request:
        method: POST
        url: https://admin.googleapis.com/graphql
        body: { query: "{ teams(filter: \\"{{ .query }}\\") { id } }" }
      fields: { value: id }
`),
    ).toEqual([expect.stringContaining("a GraphQL query can't hold templates")])
  })

  it("names what a template reads that doesn't exist", () => {
    const messages = problemsOf(
      `
lookups:
  aws:
    auth: AwsAuth
    x:
      params: [a]
      request:
        url: "https://iam.amazonaws.com/?Action=ListRoles&A={{ .params.b }}&R={{ .auth.email }}&I={{ .inputs.missing }}&L={{ .lookups.aws.y.nope }}"
      fields: { value: id }
    y:
      request: { url: https://iam.amazonaws.com/ }
      fields: { value: id }
`,
      [],
      ["name"],
    )
    expect(messages).toEqual([
      expect.stringContaining(".params.b isn't one of its params (a)"),
      expect.stringContaining(".auth.email isn't something AwsAuth knows"),
      expect.stringContaining(".inputs.missing isn't one of the form's inputs"),
      expect.stringContaining("aws.y has no field nope. Its fields are value"),
    ])
  })

  it("rejects lookups that chain in a circle", () => {
    expect(
      problemsOf(`
lookups:
  aws:
    auth: AwsAuth
    a:
      request: { url: "https://iam.amazonaws.com/?x={{ .lookups.aws.b.id }}" }
      fields: { id: id }
    b:
      request: { url: "https://iam.amazonaws.com/?x={{ .lookups.aws.a.id }}" }
      fields: { id: id }
`),
    ).toEqual([expect.stringContaining("Lookups chain in a circle: aws.a -> aws.b -> aws.a")])
  })

  it("checks a use passes exactly its params", () => {
    expect(
      problemsOf(`
checks:
  google:
    auth: GoogleAuth
    apiEnabled:
      params: [api]
      request: { url: "https://serviceusage.googleapis.com/v1/services/{{ .params.api }}" }
      expect: { path: state, equals: ENABLED }
      message: off
preflight:
  - check: google.apiEnabled
    with: { service: x }
  - check: google.missing
`),
    ).toEqual([
      expect.stringContaining("preflight[0] doesn't pass api"),
      expect.stringContaining("preflight[0] passes service, which google.apiEnabled doesn't take"),
      expect.stringContaining("preflight[1] runs google.missing, which isn't defined or included"),
    ])
  })

  it("rejects a lookup or check defined twice, and an include's preflight", () => {
    const merged = load(AWS, `${AWS}\npreflight: [{ check: aws.x }]`)
    expect(merged.problems.map((p) => p.message)).toEqual([
      expect.stringContaining("only defines lookups and checks"),
      expect.stringContaining("Lookup aws.identityStore is defined twice"),
      expect.stringContaining("Lookup aws.groups is defined twice"),
    ])
  })
})

describe("bindings", () => {
  const { definitions } = load(AWS)
  const groups = usedGroups(definitions, [{ from: "aws.groups", with: {} }], [])

  it("needs every used group, including chained ones, bound to the right kind of block", () => {
    expect(groups).toEqual(["aws"])
    expect(
      bindingProblems(definitions, groups, { aws: "management" }, [
        { id: "management", kind: "AwsAuth" },
      ]),
    ).toEqual([])
    expect(bindingProblems(definitions, groups, {}, [])).toEqual([
      expect.stringContaining("bound to a AwsAuth block"),
    ])
    expect(
      bindingProblems(definitions, groups, { aws: "workspace" }, [
        { id: "workspace", kind: "GoogleAuth" },
      ]),
    ).toEqual([expect.stringContaining("a GoogleAuth block, but aws needs a AwsAuth block")])
    expect(
      bindingProblems(definitions, groups, { aws: "x", extra: "y" }, [
        { id: "x", kind: "AwsAuth" },
      ]),
    ).toEqual([expect.stringContaining("binds extra, but no lookup or check the form uses")])
  })

  it("needs the bound block to request the group's scopes", () => {
    const google = load(`
lookups:
  google:
    auth: GoogleAuth
    scopes: [scope.a, scope.b]
    me:
      request: { url: https://admin.googleapis.com/x }
      fields: { email: primaryEmail }
`).definitions
    expect(
      bindingProblems(google, ["google"], { google: "w" }, [
        { id: "w", kind: "GoogleAuth", scopes: ["scope.a"] },
      ]),
    ).toEqual([expect.stringContaining("doesn't request scope.b")])
  })
})
