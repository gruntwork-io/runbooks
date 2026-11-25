/**
 * Every fixture's `runbook_test.yml` against the `runbook_test.yml` schema
 * (work product 2.11), bound to its runbook through a registry with today's
 * 21 tags. The real registry has no blocks until phase 3, so this one stands
 * in: each tag's class and effects as the plan gives them ("The classes" and
 * "Effects and capabilities"), its props as `props.json` lists them, taken
 * as written, since the stand-in checks what a step may say about a block,
 * not the block's props.
 */
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Effect, Option, Schema, Stream } from "effect"
import {
  type Alias,
  defineCredential,
  defineDisplay,
  defineForm,
  defineTask,
  type MachineEffect,
} from "@runbooks/blocks-core/contract"
import type { AnyBlock, Registry } from "@runbooks/blocks-core/registry"
import { configErrors } from "@runbooks/core/document/document"
import { parseRunbook } from "@runbooks/core/document/parse"
import { boundTestFile, parseTestFile, targetsOf } from "@runbooks/cli/testFile"
import { RUNBOOKS_VERSION } from "../src/runbooks-version.ts"
import { FIXTURES } from "./baseline.ts"

const ROOT = path.resolve(import.meta.dir, "..")
const PROPS: Record<string, ReadonlyArray<string>> = JSON.parse(
  readFileSync(path.join(import.meta.dir, "props.json"), "utf8"),
)

/** Props as written: the stand-in takes any. */
const AnyProps = Schema.Record(Schema.String, Schema.Unknown)
type AnyProps = typeof AnyProps.Type

const base = (name: string) => ({
  name,
  since: "0.1.0",
  props: AnyProps,
  children: { kind: "markdown" } as const,
  references: {},
  runbookFiles: () => [],
})

/** An `outputs={["a", "b"]}` prop's names. */
const outputsProp = (p: AnyProps) =>
  Object.fromEntries(
    (Array.isArray(p.outputs) ? p.outputs : [])
      .filter((key): key is string => typeof key === "string")
      .map((key) => [key, { sensitive: false }]),
  )

const noForm = { fields: [], sections: [] }

const display = (name: string) =>
  defineDisplay({ ...base(name), class: "display", provides: [], effects: [] })

const form = (name: string) =>
  defineForm({
    ...base(name),
    class: "form",
    provides: ["values"],
    effects: [],
    outputs: outputsProp,
    fields: () => Effect.succeed(noForm),
    plugins: [],
  })

const task = (
  name: string,
  effects: ReadonlyArray<MachineEffect>,
  options: { readonly fields?: boolean } = {},
) =>
  defineTask({
    ...base(name),
    class: "task",
    provides: ["run"],
    effects,
    outputs: () => ({}),
    ...(options.fields === true ? { fields: () => Effect.succeed(noForm) } : {}),
    run: () => Stream.empty,
    instruction: () => [],
    plugins: [],
  })

const credential = (name: string, scope: string) =>
  defineCredential({
    ...base(name),
    class: "credential",
    provides: ["env"],
    effects: ["network"],
    scope,
    provider: scope,
    envNames: [],
    outputs: () => ({}),
    request: () => ({
      detect: [],
      pins: {},
      requirements: [],
      settings: {},
      defaultMethod: Option.none(),
      methodDefaults: {},
    }),
    instruction: () => [],
  })

const alias = (name: string, of: string, locked: AnyProps): Alias<AnyProps> => ({
  name,
  since: "0.1.0",
  of,
  locked,
})

/**
 * Today's 21 tags. The plan: GitClone declares `push`, for an empty remote,
 * and GitPullRequest for its branch; Template has a form of its own, the
 * template's variables.
 */
const STAND_IN: Registry = {
  Admonition: display("Admonition"),
  Chapter: display("Chapter"),
  Inputs: form("Inputs"),
  DirPicker: form("DirPicker"),
  Iframe: form("Iframe"),
  Command: task("Command", ["process"]),
  Check: task("Check", ["process"]),
  Finish: task("Finish", ["process"]),
  Prerequisites: task("Prerequisites", ["process"]),
  Template: task("Template", ["files"], { fields: true }),
  TemplateInline: task("TemplateInline", ["files"]),
  GitClone: task("GitClone", ["process", "network", "repository", "push"]),
  GitPullRequest: task("GitPullRequest", ["process", "network", "push"]),
  AwsAuth: credential("AwsAuth", "aws"),
  GoogleAuth: credential("GoogleAuth", "google"),
  AzureAuth: credential("AzureAuth", "azure"),
  GitAuth: credential("GitAuth", "git"),
  GitHubAuth: alias("GitHubAuth", "GitAuth", { provider: "github" }),
  GitLabAuth: alias("GitLabAuth", "GitAuth", { provider: "gitlab" }),
  GitHubPullRequest: alias("GitHubPullRequest", "GitPullRequest", { provider: "github" }),
  GitLabMergeRequest: alias("GitLabMergeRequest", "GitPullRequest", { provider: "gitlab" }),
}

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
  const parsed = parseRunbook(readFileSync(runbook, "utf8"), STAND_IN, {
    file: runbook,
    appVersion: RUNBOOKS_VERSION,
  })
  if (parsed._tag === "Invalid")
    return configErrors(parsed)
      .map((e) => `${e.code}: ${e.message}`)
      .join("\n")
  const schema = boundTestFile(targetsOf(parsed.document, STAND_IN))
  const result = Effect.runSync(
    Effect.result(parseTestFile(fixture, readFileSync(path.join(ROOT, fixture), "utf8"), schema)),
  )
  return result._tag === "Failure" ? result.failure.message : undefined
}

describe("the runbook_test.yml schema, against the fixtures", () => {
  it("stands in a block or alias for each of today's 21 tags", () => {
    expect(Object.keys(STAND_IN).sort()).toEqual(Object.keys(PROPS).sort())
    const blocks = Object.values(STAND_IN).filter((e): e is AnyBlock => "class" in e)
    expect(blocks).toHaveLength(17)
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
})
