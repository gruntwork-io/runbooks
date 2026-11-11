import { describe, it, expect } from "bun:test"
import { parseSimulation } from "./scenarios.ts"
import {
  simulatedApplied,
  simulatedInputs,
  simulatedOutputs,
  simulatedPlan,
  simulatedResources,
} from "./unit.ts"

describe("simulated plan and apply", () => {
  const scenarios = parseSimulation(`
scenarios:
  happy:
    units:
      apply-group:
        inputsFrom: group
        inputs: { owners: [a@example.com, b@example.com] }
        delayMs: 10
        resources:
          - address: google_cloud_identity_group.group
            values: { group_key: [{ id: "{{ .id }}" }] }
            computed: { name: groups/123 }
          - address: google_cloud_identity_group_membership.owners["{{ .each }}"]
            forEach: owners
            values: { member: "{{ .each }}" }
        outputs:
          url: https://admin.google.com/groups/123
          email: "{{ .id }}"
  fails:
    extends: happy
    units:
      apply-group:
        applyError: No permission.
`)
  const unit = scenarios[0]!.units["apply-group"]!
  const inputs = simulatedInputs(unit, {
    group: { id: "team@example.com", owners: ["c@example.com"] },
  })

  it("reads the inputs of the block it names, under its own", () => {
    expect(inputs).toEqual({
      id: "team@example.com",
      owners: ["a@example.com", "b@example.com"],
    })
  })

  it("plans one resource per forEach item, with computed values known after apply", () => {
    const plan = simulatedPlan(unit, inputs)
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

  it("applies with the computed values, and renders the outputs in the module's order", () => {
    const [first] = simulatedResources(unit, inputs)
    expect(simulatedApplied(first!.address, first!.row, first!.resource).properties).toEqual({
      group_key: [{ id: "team@example.com" }],
      name: "groups/123",
    })
    expect(simulatedOutputs(unit, inputs, ["email"], new Set(["email"]))).toEqual([
      { name: "email", value: "team@example.com", sensitive: true },
      { name: "url", value: "https://admin.google.com/groups/123", sensitive: false },
    ])
  })

  it("keeps what a scenario extends, replacing only the keys it gives", () => {
    const failing = scenarios[1]!.units["apply-group"]!
    expect(failing.applyError).toBe("No permission.")
    expect(failing.resources).toHaveLength(2)
    expect(failing.inputsFrom).toBe("group")
  })

  it("updates a resource that exists, keeping its computed values, and deletes one", () => {
    const [scenario] = parseSimulation(`
scenarios:
  exists:
    units:
      apply:
        resources:
          - address: google_cloud_identity_group.group
            before: { display_name: Old }
            values: { display_name: "{{ .name }}" }
            computed: { name: groups/123 }
          - address: google_cloud_identity_group_membership.old
            action: delete
            before: { id: old@example.com }
`)
    const plan = simulatedPlan(scenario!.units.apply!, { name: "New" })
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
    units:
      apply:
        resources:
          - { address: a.b, action: move }
`),
    ).toThrow("action must be one of create, update, replace, delete")
  })
})
