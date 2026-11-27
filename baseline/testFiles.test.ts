/**
 * Every fixture's `runbook_test.yml` against the `runbook_test.yml` schema
 * (work product 2.11), bound to its runbook through the registry with
 * today's 22 tags (`standIns.ts`), the tags `props.json` lists.
 */
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import type { AnyBlock } from "@runbooks/blocks-core/registry"
import * as registry from "@runbooks/blocks"
import { configErrors } from "@runbooks/core/document/document"
import { parseRunbook } from "@runbooks/core/document/parse"
import { boundTestFile, parseTestFile, targetsOf } from "@runbooks/cli/testFile"
import { RUNBOOKS_VERSION } from "../src/runbooks-version.ts"
import { FIXTURES } from "./baseline.ts"
import { BLOCKS, STAND_IN } from "./standIns.ts"

const ROOT = path.resolve(import.meta.dir, "..")
const PROPS: Record<string, ReadonlyArray<string>> = JSON.parse(
  readFileSync(path.join(import.meta.dir, "props.json"), "utf8"),
)

/**
 * The fixtures that do not decode, each with its problem. All three are the
 * same conflict between the plan and the fixtures: the plan has GitClone
 * declare `push`, to initialize an empty remote, and a block that declares
 * `push` is external, which a test only skips. These fixtures clone a public
 * repository and expect success. Either GitClone's push is declared apart
 * from its clone, or these steps say `skip`.
 */
const DOES_NOT_DECODE: Record<string, string> = {
  "testdata/feature-demos/file-workspace/runbook_test.yml":
    'runbook_test.yml:21:9: tests[0].steps[0].expect: <GitClone> "clone-infra" declares push',
  "testdata/feature-demos/git-clone/runbook_test.yml":
    'runbook_test.yml:14:9: tests[0].steps[1].expect: <GitClone> "clone-subdir" declares push',
  "testdata/feature-demos/inputs-and-outputs/runbook_test.yml":
    'runbook_test.yml:22:9: tests[0].steps[0]: <GitClone> "clone-from-inputs" declares push',
}

/** The problems in one fixture: its runbook's that refuse it, or its test file's. */
function problems(fixture: string): string | undefined {
  const folder = path.join(ROOT, path.dirname(fixture))
  const runbook = path.join(folder, "runbook.mdx")
  const parsed = parseRunbook(readFileSync(runbook, "utf8"), BLOCKS, {
    file: runbook,
    appVersion: RUNBOOKS_VERSION,
  })
  if (parsed._tag === "Invalid")
    return configErrors(parsed)
      .map((e) => `${e.code}: ${e.message}`)
      .join("\n")
  const schema = boundTestFile(targetsOf(parsed.document, BLOCKS))
  const result = Effect.runSync(
    Effect.result(parseTestFile(fixture, readFileSync(path.join(ROOT, fixture), "utf8"), schema)),
  )
  return result._tag === "Failure" ? result.failure.message : undefined
}

/**
 * Each output an assertion in `fixture` reads from a block the real registry
 * has, and that the block does not declare. The new tree keeps only a
 * block's declared outputs (decision 8), so the assertion would fail.
 */
function undeclaredAssertedOutputs(fixture: string): string[] {
  const runbook = path.join(ROOT, path.dirname(fixture), "runbook.mdx")
  const parsed = parseRunbook(readFileSync(runbook, "utf8"), BLOCKS, {
    file: runbook,
    appVersion: RUNBOOKS_VERSION,
  })
  // A runbook that does not parse is the decode test's to report.
  if (parsed._tag === "Invalid") return []
  const targets = targetsOf(parsed.document, BLOCKS)
  const file = Effect.runSync(
    parseTestFile(fixture, readFileSync(path.join(ROOT, fixture), "utf8")),
  )
  return file.tests
    .flatMap((test) => [
      ...(test.steps ?? []).flatMap((step) => step.assertions ?? []),
      ...(test.assertions ?? []),
    ])
    .flatMap((assertion) => {
      if (!("output" in assertion)) return []
      const target = targets.get(assertion.block)
      if (target?.outputs === undefined || !(target.tag in registry)) return []
      return target.outputs.includes(assertion.output)
        ? []
        : [`${fixture}: ${assertion.type} reads ${assertion.block}.${assertion.output}`]
    })
}

describe("the runbook_test.yml schema, against the fixtures", () => {
  it("stands in a block or alias for each of today's 22 tags", () => {
    expect(Object.keys(STAND_IN).sort()).toEqual(Object.keys(PROPS).sort())
    const blocks = Object.values(STAND_IN).filter((e): e is AnyBlock => "class" in e)
    expect(blocks).toHaveLength(18)
  })

  it("uses the real registry's entry for each tag it has", () => {
    expect(Object.keys(registry)).not.toHaveLength(0)
    for (const [tag, entry] of Object.entries(registry)) expect(BLOCKS[tag]).toBe(entry)
  })

  it("decodes every fixture but those it names, each for the reason it gives", () => {
    const found: Record<string, string> = {}
    for (const fixture of FIXTURES) {
      const problem = problems(fixture)
      if (problem !== undefined) found[fixture] = problem
    }
    expect(Object.keys(found).sort()).toEqual(Object.keys(DOES_NOT_DECODE).sort())
    for (const [fixture, reason] of Object.entries(DOES_NOT_DECODE))
      expect(found[fixture]).toContain(reason)
  })

  it("asserts only on outputs their blocks declare, for each block the registry has", () => {
    expect(FIXTURES.flatMap(undeclaredAssertedOutputs)).toEqual([])
  })
})
