import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  hasChanges,
  parseRunReport,
  summarizePlan,
  summarizePlanDir,
  unitNameOf,
  type PlanDirFile,
  type PlanUnit,
} from "./planSummary.ts"

// Real plans, from the two steps of testdata/feature-demos/terragrunt-plan:
// its stack applied, then `terragrunt run --all --json-out-dir <dir>
// --report-file <dir>/report.json -- plan` with PLAN_DEMO_CHANGE=true.
const FIXTURES = join(import.meta.dir, "../../../testdata/test-fixtures/terragrunt-plans")
const fixture = (relativePath: string): PlanDirFile => ({
  relativePath,
  content: { json: JSON.parse(readFileSync(join(FIXTURES, relativePath), "utf8")) },
})
const fixtureFiles = [
  fixture("report.json"),
  fixture("subscriptions/dev/tfplan.json"),
  fixture("subscriptions/prod/tfplan.json"),
  fixture("subscriptions/staging/tfplan.json"),
]

/** A plan with the given resource changes, as `show -json` prints one. */
const plan = (resourceChanges: unknown[], extra: Record<string, unknown> = {}) => ({
  format_version: "1.2",
  resource_changes: resourceChanges,
  ...extra,
})

const change = (address: string, c: Record<string, unknown>) => ({ address, change: c })

const unitNamed = (units: readonly PlanUnit[], name: string): PlanUnit => {
  const unit = units.find((u) => u.name === name)
  if (!unit) throw new Error(`no unit ${name}`)
  return unit
}

describe("summarizePlanDir on a Terragrunt run --all plan", () => {
  const summary = summarizePlanDir(fixtureFiles)!

  it("has a unit per plan, named by its path, with the report's result", () => {
    expect(summary.units.map((u) => [u.name, u.result])).toEqual([
      ["subscriptions/dev", "succeeded"],
      ["subscriptions/prod", "succeeded"],
      ["subscriptions/staging", "succeeded"],
    ])
  })

  it("counts each unit's changes, with a replace apart from adds and destroys", () => {
    expect(unitNamed(summary.units, "subscriptions/dev").counts).toMatchObject({
      add: 0,
      change: 1,
      destroy: 1,
      replace: 0,
    })
    expect(hasChanges(unitNamed(summary.units, "subscriptions/prod").counts)).toBe(false)
    expect(unitNamed(summary.units, "subscriptions/staging").counts).toMatchObject({
      add: 0,
      change: 2,
      destroy: 1,
      replace: 1,
    })
    expect(summary.totals).toMatchObject({ add: 0, change: 3, destroy: 2, replace: 1 })
  })

  it("lists the most destructive changes first", () => {
    expect(
      unitNamed(summary.units, "subscriptions/staging").resources.map((r) => [r.action, r.address]),
    ).toEqual([
      ["delete", "terraform_data.legacy_role_assignment[0]"],
      ["replace", "terraform_data.managed_identity"],
      ["update", "terraform_data.federated_credential"],
      ["update", "terraform_data.role_definition"],
    ])
  })

  it("shows the attributes that change, the one forcing a replacement first", () => {
    const identity = unitNamed(summary.units, "subscriptions/staging").resources.find(
      (r) => r.address === "terraform_data.managed_identity",
    )!
    expect(identity.attributes[0]).toEqual({
      path: "triggers_replace[0]",
      before: '"eastus"',
      after: '"westus2"',
      forcesReplacement: true,
    })
    expect(identity.attributes).toContainEqual({
      path: "input.location",
      before: '"eastus"',
      after: '"westus2"',
    })
    expect(identity.attributes).toContainEqual(
      expect.objectContaining({ path: "id", unknownAfter: true }),
    )
  })

  it("never carries a sensitive value, even one OpenTofu copied without its mark", () => {
    // federated_credential's `output` holds the sensitive secret, but the
    // plan only marks `input.secret`.
    expect(JSON.stringify(summary)).not.toContain("s3cr3t")
    const credential = unitNamed(summary.units, "subscriptions/staging").resources.find(
      (r) => r.address === "terraform_data.federated_credential",
    )!
    expect(credential.attributes).toContainEqual({
      path: "output",
      sensitive: true,
      unknownAfter: true,
    })
  })

  it("lists the outputs that change", () => {
    expect(unitNamed(summary.units, "subscriptions/staging").outputs).toEqual([
      { name: "identity_id", action: "update" },
    ])
  })
})

describe("summarizePlan", () => {
  it("leaves out no-ops and data source reads", () => {
    const unit = summarizePlan(
      "u",
      plan([
        change("a.noop", { actions: ["no-op"] }),
        change("data.a.read", { actions: ["read"] }),
      ]),
    )
    expect(unit.resources).toEqual([])
    expect(hasChanges(unit.counts)).toBe(false)
  })

  it("reports imports, moves and forgets", () => {
    const unit = summarizePlan(
      "u",
      plan([
        change("a.imported", { actions: ["no-op"], importing: { id: "x" }, before: {}, after: {} }),
        {
          ...change("a.new_name", { actions: ["no-op"], before: {}, after: {} }),
          previous_address: "a.old_name",
        },
        change("a.forgotten", { actions: ["forget"], before: { id: "1" }, after: null }),
      ]),
    )
    expect(unit.resources.map((r) => [r.action, r.address, r.previousAddress])).toEqual([
      ["forget", "a.forgotten", undefined],
      ["import", "a.imported", undefined],
      ["move", "a.new_name", "a.old_name"],
    ])
    expect(unit.counts).toMatchObject({ import: 1, move: 1, forget: 1 })
  })

  it("lists a create's known values and those known after apply, but not its nulls", () => {
    const unit = summarizePlan(
      "u",
      plan([
        change("a.b", {
          actions: ["create"],
          before: null,
          after: { name: "x", tags: { env: "dev" }, description: null },
          after_unknown: { id: true, tags: {} },
        }),
      ]),
    )
    expect(unit.resources[0]!.attributes).toEqual([
      { path: "name", after: '"x"' },
      { path: "tags.env", after: '"dev"' },
      { path: "id", unknownAfter: true },
    ])
  })

  it("hides a sensitive leaf, and a whole value with a sensitive part", () => {
    const unit = summarizePlan(
      "u",
      plan([
        change("a.b", {
          actions: ["update"],
          before: { password: "old-password", config: { key: "old-key", region: "a" } },
          after: { password: "new-password" },
          before_sensitive: { password: true, config: { key: true } },
          after_sensitive: { password: true },
          after_unknown: { config: true },
        }),
      ]),
    )
    expect(JSON.stringify(unit)).not.toMatch(/old-|new-/)
    expect(unit.resources[0]!.attributes).toEqual([
      { path: "password", sensitive: true },
      { path: "config", sensitive: true, unknownAfter: true },
    ])
  })

  it("hides a value holding a sensitive variable's value", () => {
    const unit = summarizePlan(
      "u",
      plan(
        [
          change("a.b", {
            actions: ["update"],
            before: { url: "https://x" },
            after: { url: "https://user:hunter22@x" },
          }),
        ],
        {
          variables: { token: { value: "hunter22" } },
          configuration: { root_module: { variables: { token: { sensitive: true } } } },
        },
      ),
    )
    expect(unit.resources[0]!.attributes).toEqual([{ path: "url", sensitive: true }])
  })

  it("marks an errored plan", () => {
    expect(summarizePlan("u", plan([], { errored: true })).errored).toBe(true)
  })
})

describe("summarizePlanDir", () => {
  it("is null when the script wrote nothing it can read as a plan or report", () => {
    expect(summarizePlanDir([])).toBeNull()
    expect(
      summarizePlanDir([{ relativePath: "notes.json", content: { json: { hello: 1 } } }]),
    ).toBeNull()
  })

  it("shows a unit the report has but that wrote no plan, such as one that failed", () => {
    const summary = summarizePlanDir([
      {
        relativePath: "report.json",
        content: {
          json: [
            {
              Name: "app",
              Started: "",
              Ended: "",
              Result: "failed",
              Reason: "run error",
              Cause: "exit status 1",
            },
          ],
        },
      },
    ])
    expect(summary?.units).toEqual([
      expect.objectContaining({
        name: "app",
        planned: false,
        result: "failed",
        reason: "run error",
        cause: "exit status 1",
      }),
    ])
  })

  it("shows a plan file it couldn't read as a unit with the error", () => {
    const summary = summarizePlanDir([
      { relativePath: "app/tfplan.json", content: { error: "The file isn't valid JSON." } },
    ])
    expect(summary?.units).toEqual([
      expect.objectContaining({ name: "app", planned: false, error: "The file isn't valid JSON." }),
    ])
  })
})

describe("unitNameOf", () => {
  it("is the directory Terragrunt mirrors the unit to, or a top-level file's name", () => {
    expect(unitNameOf("live/prod/vpc/tfplan.json")).toBe("live/prod/vpc")
    expect(unitNameOf("vpc.json")).toBe("vpc")
  })
})

describe("parseRunReport", () => {
  it("is null for anything that isn't a run report", () => {
    expect(parseRunReport({})).toBeNull()
    expect(parseRunReport([])).toBeNull()
    expect(parseRunReport([{ Name: "a", Result: "maybe" }])).toBeNull()
  })
})
