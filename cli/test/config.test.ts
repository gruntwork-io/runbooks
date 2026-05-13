import { describe, it, expect } from "bun:test"
import {
  parseConfig,
  getTimeout,
  getOutputPath,
  isParallelizable,
  shouldUseTempWorkingDir,
  isLiteralInput,
  isFuzzInput,
} from "./config.ts"

const baseYaml = (extra = "") => `version: 1
${extra}
tests:
  - name: smoke
    steps:
      - block: hello-world
        expect: success
`

describe("parseConfig — happy paths", () => {
  it("parses a minimal valid config", () => {
    const cfg = parseConfig(baseYaml())
    expect(cfg.version).toBe(1)
    expect(cfg.tests).toHaveLength(1)
    expect(cfg.tests[0].name).toBe("smoke")
    expect(cfg.tests[0].steps?.[0].block).toBe("hello-world")
    expect(cfg.tests[0].steps?.[0].expect).toBe("success")
  })

  it("defaults the timeout to 5m when missing", () => {
    const cfg = parseConfig(baseYaml())
    expect(cfg.settings.timeout).toBe("5m")
    expect(getTimeout(cfg.settings)).toBe(5 * 60 * 1000)
  })

  it("classifies fuzz vs literal inputs", () => {
    const cfg = parseConfig(`version: 1
tests:
  - name: t
    inputs:
      foo:
        literal: 42
      bar:
        fuzz: { type: string, minLength: 3 }
    steps:
      - block: x
        expect: success
`)
    const inputs = cfg.tests[0].inputs!
    expect(isLiteralInput(inputs.foo)).toBe(true)
    expect(isFuzzInput(inputs.bar)).toBe(true)
    if (isFuzzInput(inputs.bar)) {
      expect(inputs.bar.fuzz.type).toBe("string")
      expect(inputs.bar.fuzz.minLength).toBe(3)
    }
  })

  it("preserves env, description, and step.expect default", () => {
    const cfg = parseConfig(`version: 1
tests:
  - name: t
    description: tag-along desc
    env:
      AWS_REGION: us-east-1
    steps:
      - block: x
`)
    expect(cfg.tests[0].description).toBe("tag-along desc")
    expect(cfg.tests[0].env).toEqual({ AWS_REGION: "us-east-1" })
    // Missing expect defaults to "success".
    expect(cfg.tests[0].steps?.[0].expect).toBe("success")
  })

  it("parses each allowed expect value", () => {
    const cfg = parseConfig(`version: 1
tests:
  - name: t
    steps:
      - { block: a, expect: success }
      - { block: b, expect: fail }
      - { block: c, expect: warn }
      - { block: d, expect: blocked }
      - { block: e, expect: skip }
      - { block: f, expect: config_error }
`)
    const expects = cfg.tests[0].steps!.map((s) => s.expect)
    expect(expects).toEqual([
      "success",
      "fail",
      "warn",
      "blocked",
      "skip",
      "config_error",
    ])
  })

  it("parses assertions with the required fields", () => {
    const cfg = parseConfig(`version: 1
tests:
  - name: t
    steps:
      - block: x
    assertions:
      - { type: file_exists, path: out.txt }
      - { type: file_contains, path: out.txt, contains: hello }
      - { type: output_equals, block: x, output: name, value: alice }
`)
    expect(cfg.tests[0].assertions).toHaveLength(3)
  })
})

describe("parseConfig — failure paths", () => {
  it("rejects an unsupported version", () => {
    expect(() => parseConfig(`version: 2\ntests:\n  - name: x\n    steps: [{block: y}]`)).toThrow(
      /Unsupported config version/,
    )
  })

  it("rejects an empty tests list", () => {
    expect(() => parseConfig(`version: 1\ntests: []`)).toThrow(
      /At least one test case/,
    )
  })

  it("rejects a test case without a name", () => {
    expect(() =>
      parseConfig(`version: 1\ntests:\n  - description: nameless\n    steps: [{block: x}]`),
    ).toThrow(/name is required/)
  })

  it("rejects a step without a block", () => {
    expect(() =>
      parseConfig(`version: 1\ntests:\n  - name: t\n    steps:\n      - expect: success`),
    ).toThrow(/block is required/)
  })

  it("rejects a step with an unknown expect value", () => {
    expect(() =>
      parseConfig(`version: 1\ntests:\n  - name: t\n    steps:\n      - block: x\n        expect: maybe`),
    ).toThrow(/invalid expect value/)
  })

  it("rejects assertions missing required fields per type", () => {
    expect(() =>
      parseConfig(`version: 1\ntests:\n  - name: t\n    steps: [{block: x}]\n    assertions:\n      - type: file_contains\n        path: out.txt`),
    ).toThrow(/contains is required/)

    expect(() =>
      parseConfig(`version: 1\ntests:\n  - name: t\n    steps: [{block: x}]\n    assertions:\n      - type: file_matches\n        path: out.txt`),
    ).toThrow(/pattern is required/)

    expect(() =>
      parseConfig(`version: 1\ntests:\n  - name: t\n    steps: [{block: x}]\n    assertions:\n      - type: output_equals\n        block: x`),
    ).toThrow(/output is required/)
  })

  it("rejects an unknown assertion type", () => {
    expect(() =>
      parseConfig(`version: 1\ntests:\n  - name: t\n    steps: [{block: x}]\n    assertions:\n      - type: misspelled_kind`),
    ).toThrow(/unknown assertion type/)
  })

  it("rejects an unparseable timeout", () => {
    expect(() =>
      parseConfig(`version: 1\nsettings: { timeout: forever }\ntests:\n  - name: t\n    steps: [{block: x}]`),
    ).toThrow(/Invalid timeout format/)
  })
})

describe("settings helpers", () => {
  it("getTimeout parses ms / s / m / h units", () => {
    expect(getTimeout({ timeout: "500ms" })).toBe(500)
    expect(getTimeout({ timeout: "30s" })).toBe(30_000)
    expect(getTimeout({ timeout: "2m" })).toBe(120_000)
    expect(getTimeout({ timeout: "1h" })).toBe(3_600_000)
  })

  it("getOutputPath defaults to 'generated'", () => {
    expect(getOutputPath({})).toBe("generated")
    expect(getOutputPath({ output_path: "out" })).toBe("out")
  })

  it("isParallelizable defaults to true", () => {
    expect(isParallelizable({})).toBe(true)
    expect(isParallelizable({ parallelizable: false })).toBe(false)
  })

  it("shouldUseTempWorkingDir defaults to true", () => {
    expect(shouldUseTempWorkingDir({})).toBe(true)
    expect(shouldUseTempWorkingDir({ use_temp_working_dir: false })).toBe(false)
  })
})
