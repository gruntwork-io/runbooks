import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { BASELINE_MCP_TOOLS } from "@runbooks/core/protocol"
import {
  E2E_SPECS,
  FIXTURES,
  MCP_TOOLS_SOURCE,
  PROPS_FILE,
  RUNBOOK_TEST_YML,
  STEP_0_E2E_SPECS,
} from "./baseline.ts"
import { documentedProps } from "./props.ts"

const ROOT = path.resolve(import.meta.dir, "..")
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8")
const sorted = (items: Iterable<string>) => [...items].sort((a, b) => a.localeCompare(b))
const missing = (files: ReadonlyArray<string>) =>
  files.filter((f) => !existsSync(path.join(ROOT, f)))

/** The string members of `export type <name> = | "a" | "b"` in a source file. */
const unionMembers = (source: string, name: string) => {
  const match = new RegExp(`export type ${name} =([^=]*?)\\n\\n`, "s").exec(source)
  return sorted([...(match?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!))
}

describe("the frozen baseline, against today's tree", () => {
  it("names 37 fixtures, every one there is, and each exists", () => {
    const found = [
      ...new Bun.Glob("testdata/{feature-demos,sample-runbooks}/*/runbook_test.yml").scanSync(ROOT),
    ]
    expect(FIXTURES).toHaveLength(37)
    expect(missing(FIXTURES)).toEqual([])
    expect(sorted(found)).toEqual(sorted(FIXTURES))
  })

  it("names 25 e2e specs and the two step 0 adds, and each exists", () => {
    expect(E2E_SPECS).toHaveLength(25)
    expect(missing([...E2E_SPECS, ...STEP_0_E2E_SPECS])).toEqual([])
  })

  it("freezes 21 tags, and the docs still list every frozen prop", () => {
    const frozen = JSON.parse(read(PROPS_FILE)) as Record<string, string[]>
    const today = documentedProps()
    expect(Object.keys(frozen)).toHaveLength(21)
    expect(sorted(Object.keys(today))).toEqual(sorted(Object.keys(frozen)))
    const dropped = Object.entries(frozen).flatMap(([tag, props]) =>
      props.filter((p) => !today[tag]?.includes(p)).map((p) => `${tag}.${p}`),
    )
    expect(dropped).toEqual([])
  })

  it("freezes runbook_test.yml's expect values and assertion types as today's CLI parses them", () => {
    const parser = read(RUNBOOK_TEST_YML.parser)
    expect(unionMembers(parser, "ExpectedStatus")).toEqual(sorted(RUNBOOK_TEST_YML.expect))
    expect(unionMembers(parser, "AssertionType")).toEqual(sorted(RUNBOOK_TEST_YML.assertions))
    expect(missing([RUNBOOK_TEST_YML.docs])).toEqual([])
  })

  it("maps exactly the MCP tools the in-app server registers (decision 12)", () => {
    const registered = Array.from(
      read(MCP_TOOLS_SOURCE).matchAll(/registerTool\(\s*"([a-z_]+)"/g),
      (m) => m[1]!,
    )
    expect(sorted(registered)).toEqual(sorted(Object.keys(BASELINE_MCP_TOOLS)))
  })
})
