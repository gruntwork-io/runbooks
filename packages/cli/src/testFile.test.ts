import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Effect, type JsonSchema, Schema, SchemaRepresentation } from "effect"
import YAML from "yaml"
import type { Registry } from "@runbooks/blocks-core/registry"
import { parseRunbook } from "@runbooks/core/document/parse"
import { makeTestFileSystem } from "@runbooks/core/test-utils/TestFileSystem"
import { TOY_REGISTRY } from "@runbooks/core/test-utils/toyRegistry"
import {
  boundTestFile,
  KIND_RULES,
  kindOf,
  MAX_TEST_FILE_BYTES,
  parseTestFile,
  readTestFile,
  targetsOf,
  TestFile,
  testFileJsonSchema,
} from "./testFile.ts"

const run = TOY_REGISTRY.Run
if (run === undefined || !("class" in run) || run.class !== "task") throw new Error("no toy Run")

/**
 * The toy registry, with two external tasks: one declares `push`, the other
 * uses a plugin to update.
 */
const REGISTRY: Registry = {
  ...TOY_REGISTRY,
  Publish: { ...run, name: "Publish", effects: ["process", "push"] },
  Apply: {
    ...run,
    name: "Apply",
    plugins: [{ plugin: "tofu", levels: ["read", "update"], credentialScope: "cloud" }],
  },
}

const RUNBOOK = [
  "# Deploy",
  '<Note id="intro" title="About" />',
  '<Form id="config">\n```yaml\n- name: region\n  type: string\n```\n</Form>',
  '<Run id="build-it" command="make" outputs={["artifact"]} />',
  '<GitLogin id="git" />',
  '<Publish id="publish" command="push" />',
  '<Apply id="apply" command="apply" />',
].join("\n\n")

const document = (() => {
  const parsed = parseRunbook(RUNBOOK, REGISTRY, { file: "/rb/runbook.mdx", appVersion: "0.31.0" })
  if (parsed._tag !== "Parsed") throw new Error("the test runbook does not parse")
  return parsed.document
})()
const bound = boundTestFile(targetsOf(document, REGISTRY))

/** `text` decoded against the test runbook, or the error's message. */
function decode(text: string, schema: Schema.Codec<TestFile, unknown> = bound) {
  const result = Effect.runSync(Effect.result(parseTestFile("runbook_test.yml", text, schema)))
  return result._tag === "Success"
    ? { file: result.success, message: undefined }
    : { file: undefined, message: result.failure.message }
}

/** A test file with one test case whose steps are `steps`, as YAML. */
const withSteps = (steps: string) =>
  `version: 1\ntests:\n  - name: one\n    steps:\n${steps
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n")}\n`

const FULL = `version: 1
settings:
  use_temp_working_dir: true
  output_path: generated
  timeout: 30s
  parallelizable: false
tests:
  - name: everything
    description: Every key the format has
    env:
      STAGE: test
    inputs:
      config.region: us-west-2
      config.count: 3
      config.tags: [a, b]
      config.labels: { team: platform }
      config.name:
        fuzz: { type: string, minLength: 3, maxLength: 9 }
    steps:
      - block: intro
      - block: config
        assertions:
          - { type: output_exists, block: config, output: region }
      - block: config
        set_outputs: { region: eu-west-1 }
      - block: build-it
        expect: blocked
        missing_outputs: [outputs.config.region]
      - block: build-it
        expect: config_error
        error_contains: no such file
      - block: git
        env_prefix: TEST_
      - block: publish
        expect: skip
      - block: apply
        expect: skip
    assertions:
      - { type: file_exists, path: out.txt }
      - { type: file_not_exists, path: gone.txt }
      - { type: dir_exists, path: out }
      - { type: dir_not_exists, path: gone }
      - { type: file_contains, path: out.txt, contains: hello }
      - { type: file_not_contains, path: out.txt, contains: secret }
      - { type: file_matches, path: out.txt, pattern: "^hello" }
      - { type: file_equals, path: out.txt, value: "hello\\n" }
      - { type: output_equals, block: build-it, output: artifact, value: app.tar }
      - { type: output_matches, block: build-it, output: artifact, pattern: "\\\\.tar$" }
      - { type: files_generated, block: build-it, min_count: 2 }
      - { type: script, command: test -f out.txt }
    cleanup:
      - command: rm -f out.txt
      - path: cleanup.sh
  - name: defaults
    steps:
`

describe("a block's kind", () => {
  it("is its class, or external when it declares push or uses a plugin beyond read", () => {
    const kinds = Object.fromEntries(
      Object.entries(REGISTRY).flatMap(([tag, entry]) =>
        "class" in entry ? [[tag, kindOf(entry)]] : [],
      ),
    )
    expect(kinds).toMatchObject({
      Note: "display",
      Form: "form",
      Run: "task",
      Clone: "task",
      GitLogin: "credential",
      Publish: "external",
      Apply: "external",
    })
  })

  it("lets an external block only skip", () => {
    expect(KIND_RULES.external).toEqual({ expects: ["skip"], keys: [] })
  })
})

describe("runbook_test.yml", () => {
  it("decodes a file with every key the format has", () => {
    const { file, message } = decode(FULL)
    expect(message).toBeUndefined()
    expect(file?.tests[0]?.steps).toHaveLength(8)
    expect(file?.tests[0]?.inputs?.["config.name"]).toEqual({
      fuzz: { type: "string", minLength: 3, maxLength: 9 },
    })
    expect(file?.tests[1]?.steps).toBeNull()
  })

  it("refuses a key the format does not have, naming it and its line", () => {
    const { message } = decode(withSteps("- block: build-it\n  expects: fail"))
    expect(message).toBe(
      "runbook_test.yml:6:9: tests[0].steps[0].expects: there is no key expects here. Did you mean expect?",
    )
  })

  it("refuses unknown keys at every level", () => {
    const { message } = decode(
      "version: 1\nsetings: {}\ntests:\n  - name: a\n    step: []\n    assertions:\n      - { type: file_exists, path: a, contain: b }\n",
    )
    expect(message).toContain("runbook_test.yml:2:1: setings: there is no key setings here.")
    expect(message).toContain("runbook_test.yml:5:5: tests[0].step: there is no key step here.")
    expect(message).toContain("tests[0].assertions[0].contain: there is no key contain here.")
  })

  it("lets an external block's step only skip, and say so", () => {
    expect(decode(withSteps("- block: publish\n  expect: skip")).message).toBeUndefined()
    expect(decode(withSteps("- block: publish\n  expect: success")).message).toBe(
      'runbook_test.yml:6:9: tests[0].steps[0].expect: <Publish> "publish" declares push, so a test only skips it: say expect: skip',
    )
    expect(decode(withSteps("- block: apply")).message).toBe(
      'runbook_test.yml:5:9: tests[0].steps[0]: <Apply> "apply" uses the plugin tofu to update, so a test only skips it: say expect: skip',
    )
  })

  it("holds each step to what its block's kind allows", () => {
    expect(decode(withSteps("- block: config\n  expect: warn")).message).toContain(
      '<Form> "config" cannot be expected to be warn. Expected one of "success", "fail", "skip", "config_error"',
    )
    expect(decode(withSteps("- block: intro\n  expect: fail")).message).toContain(
      '<Note> "intro" cannot be expected to be fail',
    )
    expect(decode(withSteps("- block: build-it\n  env_prefix: TEST_")).message).toBe(
      'runbook_test.yml:6:9: tests[0].steps[0].env_prefix: A step for <Run> "build-it" cannot have env_prefix',
    )
    expect(decode(withSteps("- block: git\n  set_outputs: { a: b }")).message).toContain(
      'A step for <GitLogin> "git" cannot have set_outputs',
    )
    expect(
      decode(withSteps("- block: publish\n  expect: skip\n  assertions: []")).message,
    ).toContain('A step for <Publish> "publish" cannot have assertions')
  })

  it("keeps error_contains with config_error and missing_outputs with blocked", () => {
    expect(decode(withSteps("- block: build-it\n  error_contains: boom")).message).toBe(
      "runbook_test.yml:6:9: tests[0].steps[0].error_contains: error_contains goes with expect: config_error",
    )
    expect(
      decode(withSteps("- block: build-it\n  expect: fail\n  missing_outputs: [x]")).message,
    ).toBe(
      "runbook_test.yml:7:9: tests[0].steps[0].missing_outputs: missing_outputs goes with expect: blocked",
    )
  })

  it("sets only the outputs a form declares", () => {
    expect(decode(withSteps("- block: config\n  set_outputs: { regoin: x }")).message).toBe(
      'runbook_test.yml:6:24: tests[0].steps[0].set_outputs.regoin: <Form> "config" declares no output "regoin". It declares "region"',
    )
  })

  it("answers only a block with fields, by an id the runbook has", () => {
    const answers = (key: string) =>
      decode(`version: 1\ntests:\n  - name: a\n    inputs:\n      ${key}: x\n`).message
    expect(answers("config.region")).toBeUndefined()
    expect(answers("build-it.region")).toBe(
      'runbook_test.yml:5:7: tests[0].inputs["build-it.region"]: <Run> "build-it" has no fields for inputs to answer',
    )
    expect(answers("confg.region")).toContain('No block in the runbook has the id "confg"')
    expect(answers("region")).toBe(
      "runbook_test.yml:5:7: tests[0].inputs.region: an input is written <block id>.<field>, as config.region",
    )
  })

  it("leaves a step that names no block to the run, which fails it", () => {
    expect(decode(withSteps("- block: nowhere\n  expect: warn")).message).toBeUndefined()
  })

  it("refuses a step or an assertion whose block is not an id, at its line", () => {
    expect(decode(withSteps("- block: ../x\n  expect: warn")).message).toContain(
      "runbook_test.yml:5:9: tests[0].steps[0].block: an id is letters, digits, `-` and `_`",
    )
    const assertion = withSteps(
      "- block: build-it\n  assertions:\n    - type: output_exists\n      block: a b\n      output: x",
    )
    expect(decode(assertion).message).toContain(
      "tests[0].steps[0].assertions[0].block: an id is letters, digits, `-` and `_`",
    )
  })

  it("knows a block by its id as written and as templates write it", () => {
    expect(decode(withSteps("- block: build_it\n  expect: warn")).message).toBeUndefined()
    expect(decode(withSteps("- block: build_it\n  env_prefix: X")).message).toContain(
      'A step for <Run> "build_it" cannot have env_prefix',
    )
  })

  it("refuses a value of the wrong type with its line", () => {
    const { message } = decode(
      "version: 2\nsettings:\n  timeout: 5 minutes\ntests:\n  - name: a\n    env:\n      PORT: 8080\n    inputs:\n      config.region: { fuzz: { type: strng } }\n",
    )
    expect(message).toContain("runbook_test.yml:1:1: version: Expected 1")
    expect(message).toContain(
      "runbook_test.yml:3:3: settings.timeout: Expected a string matching the RegExp",
    )
    expect(message).toContain("runbook_test.yml:7:7: tests[0].env.PORT: Expected string")
    expect(message).toContain('tests[0].inputs["config.region"].fuzz.type: Expected "string"')
    // A map with a `fuzz` key is a fuzz configuration: no second problem says `fuzz` is not a key.
    expect(message).not.toContain("there is no key fuzz")
  })

  it("refuses an alias that names a node that holds it, at the alias, and throws nothing", () => {
    expect(decode("version: 1\ntests:\n  - &t [*t]\n").message).toBe(
      "runbook_test.yml:3:9: An alias names a node that holds it, so the data would hold itself.",
    )
  })

  it("needs at least one test case", () => {
    expect(decode("version: 1\ntests: []\n").message).toBe(
      "runbook_test.yml:2:1: tests: Expected a value with a length of at least 1",
    )
  })

  it("refuses YAML that does not parse, or names a key twice", () => {
    expect(decode("tests:\n  - name: a\n   steps: [\n").message).toMatch(
      /^runbook_test\.yml:\d+:\d+: /,
    )
    expect(decode("version: 1\nversion: 1\ntests: [{ name: a }]\n").message).toContain(
      "runbook_test.yml:2:1: a key appears twice in one map.",
    )
  })
})

describe("reading runbook_test.yml", () => {
  it("refuses a file larger than it reads", async () => {
    const big = `version: 1\n# ${"x".repeat(MAX_TEST_FILE_BYTES)}\ntests: [{ name: a }]\n`
    const result = await Effect.runPromise(
      Effect.result(readTestFile("/rb/runbook_test.yml")).pipe(
        Effect.provide(makeTestFileSystem({ "/rb/runbook_test.yml": big })),
      ),
    )
    expect(result._tag === "Failure" && result.failure.message).toBe(
      `/rb/runbook_test.yml is larger than ${MAX_TEST_FILE_BYTES} bytes.`,
    )
  })

  it("says when there is none", async () => {
    const result = await Effect.runPromise(
      Effect.result(readTestFile("/rb/runbook_test.yml")).pipe(
        Effect.provide(makeTestFileSystem({})),
      ),
    )
    expect(result._tag === "Failure" && result.failure.message).toBe(
      "/rb/runbook_test.yml does not exist.",
    )
  })
})

describe("the JSON Schema for editors", () => {
  const file = JSON.parse(testFileJsonSchema()) as JsonSchema.JsonSchema & {
    readonly $defs?: JsonSchema.Definitions
  }
  const { $defs = {}, ...root } = file
  /** The emitted file, read back into an Effect schema, as an editor reads it. */
  const fromFile = SchemaRepresentation.fromJsonSchemaDocument(
    { dialect: "draft-2020-12", schema: root, definitions: $defs },
    { patterns: "apply" },
  ) as Schema.Codec<unknown, unknown>

  /** Accepted or refused, by `TestFile` and by the emitted file. */
  const verdicts = (text: string) => {
    const value: unknown = YAML.parse(text)
    const options = { onExcessProperty: "error" } as const
    return [
      Schema.decodeUnknownResult(TestFile)(value, options)._tag,
      Schema.decodeUnknownResult(fromFile)(value, options)._tag,
    ]
  }

  const FIXTURES = [
    ...new Bun.Glob("testdata/**/runbook_test.yml").scanSync(
      path.resolve(import.meta.dir, "../../.."),
    ),
  ]

  it("is a Draft 2020-12 file with closed keys", () => {
    expect(file.$schema).toBe("https://json-schema.org/draft/2020-12/schema")
    expect(file.additionalProperties).toBe(false)
  })

  it("accepts what TestFile accepts: every fixture and a file with every key", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(37)
    for (const fixture of FIXTURES) {
      const text = readFileSync(path.resolve(import.meta.dir, "../../..", fixture), "utf8")
      expect([fixture, ...verdicts(text)]).toEqual([fixture, "Success", "Success"])
    }
    expect(verdicts(FULL)).toEqual(["Success", "Success"])
  })

  it.each([
    ["an unknown step key", withSteps("- block: a\n  expects: fail")],
    ["an unknown top-level key", "version: 1\nsetings: {}\ntests: [{ name: a }]\n"],
    ["an expect no block has", withSteps("- block: a\n  expect: done")],
    [
      "a timeout that is not a duration",
      "settings: { timeout: 5 minutes }\ntests: [{ name: a }]\n",
    ],
    ["an input key without a block id", "tests: [{ name: a, inputs: { region: x } }]\n"],
    [
      "a fuzz type that does not exist",
      "tests: [{ name: a, inputs: { a.b: { fuzz: { type: strng } } } }]\n",
    ],
    [
      "a fuzz configuration with a key it lacks",
      "tests: [{ name: a, inputs: { a.b: { fuzz: { type: int, step: 2 } } } }]\n",
    ],
    [
      "an assertion missing a key",
      "tests: [{ name: a, assertions: [{ type: file_contains, path: a }] }]\n",
    ],
    [
      "an assertion type that does not exist",
      "tests: [{ name: a, assertions: [{ type: file_is, path: a }] }]\n",
    ],
    ["a cleanup with neither key", "tests: [{ name: a, cleanup: [{ run: x }] }]\n"],
    ["an env value that is not text", "tests: [{ name: a, env: { PORT: 8080 } }]\n"],
    ["no test case", "version: 1\ntests: []\n"],
    ["another version", "version: 2\ntests: [{ name: a }]\n"],
    ["a test case with no name", "tests: [{ description: a }]\n"],
  ])("refuses what TestFile refuses: %s", (_, text) => {
    expect(verdicts(text)).toEqual(["Failure", "Failure"])
  })
})
