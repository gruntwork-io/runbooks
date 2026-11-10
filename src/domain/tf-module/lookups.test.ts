import { describe, expect, test } from "bun:test"
import { domainRows, isLookupName, matchesQuery, meRows, personRows } from "./lookups.ts"

describe("lookups", () => {
  test("knows its names", () => {
    expect(isLookupName("google.people")).toBe(true)
    expect(isLookupName("google.groups")).toBe(false)
    expect(isLookupName("toString")).toBe(false)
  })

  test("lists the primary domain first", () => {
    expect(
      domainRows([
        { domainName: "example.org", isPrimary: false },
        { domainName: "example.com", isPrimary: true },
      ]),
    ).toEqual([
      { value: "example.com", domainName: "example.com", isPrimary: true },
      { value: "example.org", domainName: "example.org", isPrimary: false },
    ])
  })

  test("gives people as value, label, and description", () => {
    expect(
      personRows([
        { email: "ana@example.com", name: "Ana Lima", title: "Engineer" },
        { email: "bo@example.com" },
      ]),
    ).toEqual([
      { value: "ana@example.com", label: "Ana Lima", description: "Engineer" },
      { value: "bo@example.com", label: "bo@example.com" },
    ])
  })

  test("gives the signed-in account as email and name", () => {
    expect(meRows("sam@example.com")).toEqual([
      { email: "sam@example.com", name: "sam@example.com" },
    ])
  })

  test("matches what the user typed in any text field, ignoring case", () => {
    expect(matchesQuery({ value: "example.com", isPrimary: true }, "EXAM")).toBe(true)
    expect(matchesQuery({ value: "example.com" }, "org")).toBe(false)
    expect(matchesQuery({ value: "x" }, "")).toBe(true)
  })
})
