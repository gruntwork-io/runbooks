import { describe, it, expect } from "bun:test"
import { noResponse, parseSimulation, simulatedResponse } from "./scenarios.ts"

const FILE = `
scenarios:
  happy-path:
    label: Happy path
    responses:
      google.domains:
        - status: 200
          body: { domains: [{ domainName: example.com }] }
      google.apiEnabled:
        - with: { api: admin.googleapis.com }
          status: 200
          body: { state: DISABLED }
        - status: 200
          delayMs: 300
          body: { state: ENABLED }
  denied:
    label: Permission denied
    extends: happy-path
    responses:
      google.domains:
        - { status: 403, body: The account can't read the directory. }
`

describe("parseSimulation", () => {
  it("merges what a scenario extends under its own answers", () => {
    const [happy, denied] = parseSimulation(FILE)
    expect(happy!.label).toBe("Happy path")
    expect(denied!.responses["google.apiEnabled"]).toEqual(happy!.responses["google.apiEnabled"]!)
    expect(denied!.responses["google.domains"]).toEqual([
      { status: 403, body: "The account can't read the directory." },
    ])
  })

  it("refuses scenarios that extend each other in a loop", () => {
    expect(() => parseSimulation("scenarios:\n  a: { extends: b }\n  b: { extends: a }\n")).toThrow(
      "loop",
    )
  })

  it("refuses a file without scenarios, and an answer without a status", () => {
    expect(() => parseSimulation("responses: {}\n")).toThrow('needs "scenarios"')
    expect(() =>
      parseSimulation("scenarios:\n  a:\n    responses:\n      x.y: [{ body: {} }]\n"),
    ).toThrow("scenarios.a.responses.x.y[0] needs a status and a body")
  })
})

describe("simulatedResponse", () => {
  const [happy, denied] = parseSimulation(FILE)

  it("answers as an API would, in JSON", () => {
    expect(simulatedResponse(happy!, "google.domains", {})).toEqual({
      reply: {
        status: 200,
        contentType: "application/json",
        body: '{"domains":[{"domainName":"example.com"}]}',
      },
      delayMs: 0,
    })
    expect(simulatedResponse(denied!, "google.domains", {})?.reply).toMatchObject({
      status: 403,
      body: "The account can't read the directory.",
    })
  })

  it("picks the answer for the use's params, and otherwise the one without any", () => {
    const admin = simulatedResponse(happy!, "google.apiEnabled", { api: "admin.googleapis.com" })
    expect(admin?.reply.body).toBe('{"state":"DISABLED"}')
    const other = simulatedResponse(happy!, "google.apiEnabled", { api: "iam.googleapis.com" })
    expect(other).toMatchObject({ reply: { body: '{"state":"ENABLED"}' }, delayMs: 300 })
  })

  it("has none for a lookup it doesn't answer, and says where to add one", () => {
    expect(simulatedResponse(happy!, "google.people", {})).toBeUndefined()
    expect(noResponse(happy!, "google.people", { q: "a" }).message).toBe(
      'simulation.yml: scenario "happy-path" has no answer for google.people with {"q":"a"}, and the module records none. Add one under responses.google.people.',
    )
  })
})
