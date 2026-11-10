import { describe, it, expect } from "bun:test"
import { parseMetadata } from "./spec.ts"
import { enableApiUrl, requiredApis } from "./requirements.ts"
import type { TfModuleSpec, TfModuleVariable } from "./types.ts"

const variable = (name: string, extra: Partial<TfModuleVariable> = {}): TfModuleVariable => ({
  name,
  label: name,
  description: "",
  tfType: "string",
  kind: "string",
  hasDefault: false,
  sensitive: false,
  primary: true,
  ...extra,
})

const spec = (googleApis: string[], variables: TfModuleVariable[]): TfModuleSpec => ({
  title: "Group",
  providers: [],
  outputs: [],
  variables,
  googleApis,
  warnings: [],
})

describe("requiredApis", () => {
  it("lists the module's APIs for the apply, then its lookups' for the suggestions", () => {
    const apis = requiredApis(
      spec(
        ["cloudidentity.googleapis.com", "people.googleapis.com"],
        [
          variable("domain", { lookup: { from: "google.domains" } }),
          variable("owners", {
            lookup: { from: "google.people" },
            shortcut: { from: "google.me" },
          }),
        ],
      ),
    )
    expect(apis).toEqual([
      { service: "cloudidentity.googleapis.com", name: "Cloud Identity API", neededFor: "apply" },
      { service: "people.googleapis.com", name: "People API", neededFor: "apply" },
      { service: "admin.googleapis.com", name: "Admin SDK API", neededFor: "suggestions" },
    ])
  })

  it("needs nothing for a module without Google APIs or lookups", () => {
    expect(requiredApis(spec([], [variable("name")]))).toEqual([])
  })
})

describe("requires.google.apis in runbook_block.yml", () => {
  it("reads the service names once each", () => {
    const metadata = parseMetadata(
      "requires:\n  google:\n    apis: [cloudidentity.googleapis.com, cloudidentity.googleapis.com]\n",
    )
    expect(metadata.googleApis).toEqual(["cloudidentity.googleapis.com"])
  })

  it("refuses a name that isn't a Google API's service name", () => {
    expect(() => parseMetadata("requires:\n  google:\n    apis: [Cloud Identity]\n")).toThrow(
      "isn't a Google API's service name",
    )
  })
})

it("links to the console page that turns an API on in the project", () => {
  expect(enableApiUrl("admin.googleapis.com", "acme-ops")).toBe(
    "https://console.cloud.google.com/apis/library/admin.googleapis.com?project=acme-ops",
  )
})
