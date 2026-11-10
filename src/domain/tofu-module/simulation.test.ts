import { describe, it, expect } from "bun:test"
import {
  parseSimulation,
  simulatedApplied,
  simulatedOutputs,
  simulatedPlan,
  simulatedResources,
  simulatedRows,
} from "./simulation.ts"

const FILE = `
scenarios:
  happy-path:
    label: Happy path
    lookups:
      google.domains:
        - { domainName: example.com, isPrimary: true }
        - { domainName: example.org, isPrimary: false }
      google.people:
        rows:
          - { value: ana@example.com, name: Ana Lima }
          - { value: bo@example.com, name: Bo Chen }
  denied:
    label: Permission denied
    extends: happy-path
    lookups:
      google.people:
        error: The account can't read the directory.
`

describe("parseSimulation", () => {
  it("merges what a scenario extends under its own answers", () => {
    const [happy, denied] = parseSimulation(FILE)
    expect(happy!.label).toBe("Happy path")
    expect(denied!.lookups["google.domains"]).toEqual(happy!.lookups["google.domains"]!)
    expect(denied!.lookups["google.people"]).toEqual({
      error: "The account can't read the directory.",
    })
  })

  it("refuses scenarios that extend each other in a loop", () => {
    expect(() => parseSimulation("scenarios:\n  a: { extends: b }\n  b: { extends: a }\n")).toThrow(
      "loop",
    )
  })

  it("refuses a file without scenarios", () => {
    expect(() => parseSimulation("lookups: {}\n")).toThrow('needs "scenarios"')
  })
})

describe("simulatedRows", () => {
  const [happy, denied] = parseSimulation(FILE)

  it("narrows rows to what the user typed, in any text field", () => {
    expect(simulatedRows(happy!, "google.people", "lima")).toEqual([
      { value: "ana@example.com", name: "Ana Lima" },
    ])
    expect(simulatedRows(happy!, "google.people", "")).toHaveLength(2)
  })

  it("fails as the scenario says", () => {
    expect(() => simulatedRows(denied!, "google.people", "")).toThrow("can't read the directory")
  })

  it("names a lookup the scenario has no answer for", () => {
    expect(() => simulatedRows(happy!, "github.repos", "")).toThrow(
      "no answer for the lookup github.repos",
    )
  })
})

describe("simulated plan and apply", () => {
  const scenarios = parseSimulation(`
scenarios:
  happy:
    modules:
      group:
        delayMs: 10
        resources:
          - address: google_cloud_identity_group.group
            values: { group_key: [{ id: "{{ .id }}" }] }
            computed: { name: groups/123 }
          - address: google_cloud_identity_group_membership.owners["{{ .each }}"]
            forEach: owners
            values: { member: "{{ .each }}" }
        outputs:
          email: "{{ .id }}"
  fails:
    extends: happy
    modules:
      group:
        applyError: No permission.
`)
  const inputs = { id: "team@example.com", owners: ["a@example.com", "b@example.com"] }

  it("plans one resource per forEach item, with computed values known after apply", () => {
    const plan = simulatedPlan(scenarios[0]!.modules.group!, inputs)
    expect(plan.resources.map((r) => r.address)).toEqual([
      "google_cloud_identity_group.group",
      'google_cloud_identity_group_membership.owners["a@example.com"]',
      'google_cloud_identity_group_membership.owners["b@example.com"]',
    ])
    expect(plan.resources[0]).toMatchObject({
      type: "google_cloud_identity_group",
      name: "group",
      properties: {
        group_key: [{ id: "team@example.com" }],
        name: { hidden: "known after apply" },
      },
    })
  })

  it("applies with the computed values, and renders the outputs", () => {
    const module = scenarios[0]!.modules.group!
    const [first] = simulatedResources(module, inputs)
    expect(simulatedApplied(first!.address, first!.row, first!.resource).properties).toEqual({
      group_key: [{ id: "team@example.com" }],
      name: "groups/123",
    })
    expect(simulatedOutputs(module, inputs, new Set())).toEqual([
      { name: "email", value: "team@example.com", sensitive: false },
    ])
  })

  it("keeps what a scenario extends, replacing only the keys it gives", () => {
    const module = scenarios[1]!.modules.group!
    expect(module.applyError).toBe("No permission.")
    expect(module.resources).toHaveLength(2)
  })

  it("updates a resource that exists, keeping its computed values, and deletes one", () => {
    const [scenario] = parseSimulation(`
scenarios:
  exists:
    modules:
      group:
        resources:
          - address: google_cloud_identity_group.group
            before: { display_name: Old }
            values: { display_name: "{{ .name }}" }
            computed: { name: groups/123 }
          - address: google_cloud_identity_group_membership.old
            action: delete
            before: { id: old@example.com }
`)
    const plan = simulatedPlan(scenario!.modules.group!, { name: "New" })
    expect(plan.resources).toEqual([
      {
        address: "google_cloud_identity_group.group",
        type: "google_cloud_identity_group",
        name: "group",
        action: "update",
        properties: { display_name: "New", name: "groups/123" },
        before: { display_name: "Old", name: "groups/123" },
      },
      {
        address: "google_cloud_identity_group_membership.old",
        type: "google_cloud_identity_group_membership",
        name: "old",
        action: "delete",
        properties: {},
        before: { id: "old@example.com" },
      },
    ])
  })

  it("rejects an action OpenTofu doesn't have", () => {
    expect(() =>
      parseSimulation(`
scenarios:
  bad:
    modules:
      group:
        resources:
          - { address: a.b, action: move }
`),
    ).toThrow("action must be one of create, update, replace, delete")
  })
})
