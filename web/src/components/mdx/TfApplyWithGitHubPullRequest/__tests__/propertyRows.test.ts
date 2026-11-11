import { describe, it, expect } from "vitest"
import { filterRows, NO_FILTER, propertyRows } from "../propertyRows"

const unknown = { hidden: "known after apply" } as const

describe("propertyRows", () => {
  it("flattens nested values to paths, leaving out empty top-level ones", () => {
    const rows = propertyRows({
      display_name: "Platform",
      description: "",
      group_key: [{ id: "p@example.com", namespace: "" }],
      labels: { "cloudidentity.googleapis.com/groups.discussion_forum": "" },
      id: unknown,
      expiry: null,
    })
    expect(rows.map((r) => r.path)).toEqual([
      "display_name",
      "group_key[0].id",
      "group_key[0].namespace",
      'labels["cloudidentity.googleapis.com/groups.discussion_forum"]',
      "id",
    ])
    expect(rows.every((r) => r.changed)).toBe(true)
  })

  it("marks what an update changes, adds, and removes", () => {
    const rows = propertyRows(
      { display_name: "New", roles: [{ name: "MEMBER" }] },
      { display_name: "Old", roles: [{ name: "MEMBER" }, { name: "OWNER" }] },
    )
    expect(rows).toEqual([
      { path: "display_name", after: "New", before: "Old", changed: true },
      { path: "roles[0].name", after: "MEMBER", before: "MEMBER", changed: false },
      { path: "roles[1].name", after: undefined, before: "OWNER", changed: true },
    ])
  })
})

describe("filterRows", () => {
  const rows = propertyRows(
    { display_name: "New", parent: "customers/C03", id: unknown },
    { display_name: "Old", parent: "customers/C03", id: "groups/1" },
  )

  it("keeps only known values, or only changed ones", () => {
    expect(filterRows(rows, { ...NO_FILTER, hideUnknown: true }, "x").map((r) => r.path)).toEqual([
      "display_name",
      "parent",
    ])
    expect(filterRows(rows, { ...NO_FILTER, onlyChanged: true }, "x").map((r) => r.path)).toEqual([
      "display_name",
      "id",
    ])
  })

  it("matches a path or a value, and keeps every row of a resource whose address matches", () => {
    expect(filterRows(rows, { ...NO_FILTER, query: "c03" }, "x").map((r) => r.path)).toEqual([
      "parent",
    ])
    expect(filterRows(rows, { ...NO_FILTER, query: "google" }, "google_group.g")).toHaveLength(3)
  })
})
