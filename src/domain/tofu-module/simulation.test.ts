import { describe, it, expect } from "bun:test"
import { parseSimulation, simulatedRows } from "./simulation.ts"

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
