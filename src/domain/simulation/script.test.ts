import { describe, it, expect } from "bun:test"
import { parseSimulation } from "./scenarios.ts"
import { scriptKey, simulatedStatus } from "./script.ts"

const FILE = `
scenarios:
  happy-path:
    scripts:
      ready:
        log: |-
          The name makes a folder name.
          The email matches.
        delayMs: 400
        outputs:
          path: "{{ .outputs.account.CODE_PATH }}"
          count: 2
  not-ready:
    extends: happy-path
    scripts:
      ready:
        status: fail
        log: [The email doesn't match.]
`

describe("simulated scripts", () => {
  it("reads a block's run, and keeps what the extended scenario gives that a scenario doesn't replace", () => {
    const [happy, notReady] = parseSimulation(FILE)
    expect(happy!.scripts["ready"]).toMatchObject({
      status: "success",
      log: ["The name makes a folder name.", "The email matches."],
      outputs: { path: "{{ .outputs.account.CODE_PATH }}", count: "2" },
      delayMs: 400,
    })
    expect(notReady!.scripts["ready"]).toMatchObject({
      status: "fail",
      log: ["The email doesn't match."],
      outputs: { path: "{{ .outputs.account.CODE_PATH }}", count: "2" },
      delayMs: 400,
    })
  })

  it("ends with the exit code a real run of that status has", () => {
    const [happy, notReady] = parseSimulation(FILE)
    expect(simulatedStatus(happy!.scripts["ready"]!)).toEqual({ status: "success", exitCode: 0 })
    expect(simulatedStatus(notReady!.scripts["ready"]!)).toEqual({ status: "fail", exitCode: 1 })
  })

  it("holds a run under its block's id with _ for -, and refuses two keys for one block", () => {
    const [scenario] = parseSimulation("scenarios:\n  a:\n    scripts:\n      set-settings: {}\n")
    expect(Object.keys(scenario!.scripts)).toEqual([scriptKey("set-settings")])
    expect(() =>
      parseSimulation("scenarios:\n  a:\n    scripts:\n      x-y: {}\n      x_y: {}\n"),
    ).toThrow("scenarios.a.scripts names one block twice: x-y and x_y")
  })

  it("refuses a status it doesn't know, and outputs that aren't text", () => {
    expect(() =>
      parseSimulation("scenarios:\n  a:\n    scripts:\n      x: { status: ok }\n"),
    ).toThrow("scenarios.a.scripts.x.status must be one of success, warn, fail")
    expect(() =>
      parseSimulation("scenarios:\n  a:\n    scripts:\n      x: { outputs: { y: [1] } }\n"),
    ).toThrow("scenarios.a.scripts.x.outputs must map each output to text")
  })
})
