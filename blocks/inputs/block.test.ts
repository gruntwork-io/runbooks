import { describe, expect, it } from "bun:test"
import path from "node:path"
import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import { BlockId, defineTask } from "@runbooks/blocks-core/contract"
import { type FieldValue, templateText } from "@runbooks/blocks-core/form"
import type { BlockStatus } from "@runbooks/blocks-core/status"
import type { ConfigError, ConfigWarning } from "@runbooks/core/document/configError"
import { serveEngine } from "@runbooks/core/handlers"
import { makeInProcessClient } from "@runbooks/core/inProcess"
import type { DocumentBlock, EngineClient, SessionId } from "@runbooks/core/protocol"
import { FileSystem } from "@runbooks/core/services/FileSystem"
import { testCredentialProviders } from "@runbooks/core/test-utils/TestCredentialProviders"
import { testFileSystem } from "@runbooks/core/test-utils/TestFileSystem"
import { testSessionStore } from "@runbooks/core/test-utils/TestSessionStore"
import { testSettingsStore } from "@runbooks/core/test-utils/TestSettingsFile"
import { makeTestSpawner } from "@runbooks/core/test-utils/TestSpawner"
import { TOY_REGISTRY } from "@runbooks/core/test-utils/toyRegistry"
import { inputs } from "./block.ts"

// Inputs through the engine, as a client drives it: the real parser, the
// real boilerplate reader and the real session, over an in-memory file
// system. A toy task, `Echo`, stands in for the blocks that read a form:
// its instruction shows the values it reads, and each run records them.

const RUNBOOK = "/rb/runbook.mdx"
const blockId = Schema.decodeSync(BlockId)

/** A reader of the forms its `inputsId` names, or of the form inside it. */
const reader = () => {
  const runs: Array<Record<string, FieldValue>> = []
  const echo = defineTask({
    name: "Echo",
    since: "0.1.0",
    class: "task",
    props: Schema.Struct({}),
    children: { kind: "markdown" },
    references: {},
    runbookFiles: () => [],
    provides: ["run"],
    effects: [],
    outputs: () => ({}),
    run: (_p, input) =>
      Stream.suspend(() => {
        runs.push(
          Object.fromEntries(
            Array.from(input.values, ([name, value]) => [name, Redacted.value(value)]),
          ),
        )
        return Stream.empty
      }),
    instruction: (_p, reads) => [
      {
        kind: "text",
        markdown: Array.from(
          reads.values,
          ([name, value]) => `${name}=${templateText(Redacted.value(value))}`,
        ).join(" "),
      },
    ],
    plugins: [],
  })
  return { echo, runs }
}

interface Session {
  readonly client: EngineClient
  readonly session: SessionId
  readonly blocks: ReadonlyArray<DocumentBlock>
  readonly warnings: ReadonlyArray<ConfigWarning>
  readonly runs: ReadonlyArray<Record<string, FieldValue>>
  /** What the reader `block` shows of the values it reads. */
  readonly shown: (block: string) => Effect.Effect<string | undefined, unknown>
  readonly set: (block: string, values: Record<string, FieldValue>) => Effect.Effect<void, unknown>
  readonly submit: (block: string) => Effect.Effect<unknown, unknown>
  readonly run: (block: string) => Effect.Effect<BlockStatus | undefined, unknown>
  readonly status: (block: string) => Effect.Effect<BlockStatus | undefined, unknown>
  /** Each field's name and value, as the form shows them. */
  readonly fields: (block: string) => Effect.Effect<ReadonlyArray<unknown>, unknown>
}

/** A trusted session of `runbook` and the files beside it, in `/rb`. */
const withSession = <A>(
  runbook: string,
  use: (s: Session) => Effect.Effect<A, unknown>,
  files: Record<string, string> = {},
): Promise<A> => {
  const { echo, runs } = reader()
  const all = {
    [RUNBOOK]: runbook,
    ...Object.fromEntries(Object.entries(files).map(([file, text]) => [`/rb/${file}`, text])),
  }
  const folders = [
    "/rb",
    ...Object.keys(all).flatMap((file) => {
      const parts = path.posix.dirname(file).split("/")
      return parts
        .map((_, i) => parts.slice(0, i + 1).join("/"))
        .filter((f) => f.startsWith("/rb/"))
    }),
  ]
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeInProcessClient("person")
        const opened = yield* client.OpenSession({ path: RUNBOOK })
        if (opened._tag !== "Opened") throw new Error(opened.errors.map((e) => e.message).join())
        const { session, trust } = opened.session
        yield* client.TrustSession({ session, hash: trust.hash })
        const document = yield* client.GetDocument({ session })
        const target = (block: string) => ({ session, block: blockId(block) })
        const view = (block: string) => client.GetBlock(target(block))
        return yield* use({
          client,
          session,
          blocks: document.blocks,
          warnings: document.warnings,
          runs,
          shown: (block) =>
            Effect.map(view(block), ({ instruction }) => {
              const [part] = instruction ?? []
              return part?.kind === "text" ? part.markdown : undefined
            }),
          set: (block, values) => Effect.asVoid(client.SetValues({ ...target(block), values })),
          submit: (block) => client.RunBlock(target(block)),
          run: (block) =>
            Effect.andThen(
              client.RunBlock(target(block)),
              Effect.map(
                client.WaitForBlock({ ...target(block), timeoutMillis: 10_000 }),
                (ended) => ended.block.status,
              ),
            ),
          status: (block) => Effect.map(view(block), ({ status }) => status),
          fields: (block) =>
            Effect.map(view(block), ({ fields }) =>
              (fields ?? []).map((field) => [field.name, field.value ?? null]),
            ),
        })
      }).pipe(
        Effect.provide(
          serveEngine({
            registry: { ...TOY_REGISTRY, Inputs: inputs, Echo: echo },
            appVersion: "0.31.0",
            workingFolders: "/work",
            stateFolders: "/state",
            processEnvironment: { PATH: "/usr/bin:/bin", HOME: "/home/someone" },
          }),
        ),
        Effect.provide(testCredentialProviders({}, [])),
        Effect.provide(testSettingsStore()),
        Effect.provide(testSessionStore()),
        Effect.provide(makeTestSpawner()),
        Effect.provide(Layer.succeed(FileSystem, testFileSystem(all, folders))),
      ),
    ),
  )
}

/** The errors of each block that has some: its id, and each error's code, line and message. */
const errorsOf = (blocks: ReadonlyArray<DocumentBlock>): ReadonlyArray<unknown> =>
  blocks.flatMap((block) =>
    block._tag === "Misconfigured"
      ? [
          [
            block.id,
            block.errors.map((e: ConfigError) => [e.code, e.location.span.start.line, e.message]),
          ],
        ]
      : [],
  )

/** The errors refusing `runbook`, or its blocks', as `errorsOf` gives them. */
const openErrors = (runbook: string, files: Record<string, string> = {}) =>
  withSession(runbook, (s) => Effect.succeed(errorsOf(s.blocks)), files)

const shown = (value: FieldValue) => ({ _tag: "Shown", value })

const fenced = (open: string, yaml: ReadonlyArray<string>) =>
  [open, "```yaml", ...yaml, "```", "</Inputs>"].join("\n")

const CONFIG = fenced('<Inputs id="config">', [
  "variables:",
  "  - name: Region",
  "    default: us-east-1",
  "  - name: Count",
  "    type: int",
  "    default: 3",
])

describe("Inputs", () => {
  it("reads its fields from the YAML inside it, a boilerplate config, in the form's order", async () => {
    const fields = await withSession(
      fenced('<Inputs id="config">', [
        "variables:",
        "  - name: Later",
        "    order: 2",
        "  - name: Region",
        "    type: Enum",
        "    options: [us-east-1, eu-west-1]",
        "    default: eu-west-1",
        "  - name: Count",
        "    type: int",
        "    default: 3",
      ]),
      (s) => s.fields("config"),
    )
    expect(fields).toEqual([
      ["Region", shown("eu-west-1")],
      ["Count", shown(3)],
      ["Later", null],
    ])
  })

  it("reads them from the file its `path` names, or the folder's boilerplate.yml, or else its boilerplate.yaml", async () => {
    const config = "variables:\n  - name: Region\n    default: from-"
    const read = (runbook: string, files: Record<string, string>) =>
      withSession(runbook, (s) => s.fields("config"), files)
    expect(
      await read('<Inputs id="config" path="vars.yml" />', { "vars.yml": `${config}file` }),
    ).toEqual([["Region", shown("from-file")]])
    expect(
      await read('<Inputs id="config" path="vpc" />', {
        "vpc/boilerplate.yml": `${config}yml`,
        "vpc/boilerplate.yaml": `${config}yaml`,
      }),
    ).toEqual([["Region", shown("from-yml")]])
    expect(
      await read('<Inputs id="config" path="vpc/" />', { "vpc/boilerplate.yaml": `${config}yaml` }),
    ).toEqual([["Region", shown("from-yaml")]])
    expect(
      await openErrors('<Inputs id="config" path="vpc" />', { "vpc/other.yml": config }),
    ).toEqual([
      ["config", [["badProp", 1, "There is no boilerplate.yml or boilerplate.yaml in vpc."]]],
    ])
  })

  it("starts each field `prefilledVariables` names with its value, from the YAML or a file", async () => {
    const prefilled = 'prefilledVariables={{ Region: "eu-west-1", Count: 5 }}'
    expect(
      await withSession(
        CONFIG.replace('<Inputs id="config">', `<Inputs id="config" ${prefilled}>`),
        (s) => s.fields("config"),
      ),
    ).toEqual([
      ["Region", shown("eu-west-1")],
      ["Count", shown(5)],
    ])
    expect(
      await withSession(
        `<Inputs id="config" path="vars.yml" ${prefilled} />`,
        (s) => s.fields("config"),
        { "vars.yml": "variables: [{ name: Region }, { name: Count, type: int }]" },
      ),
    ).toEqual([
      ["Region", shown("eu-west-1")],
      ["Count", shown(5)],
    ])
  })

  it("refuses a `prefilledVariables` name the form lacks (H2)", async () => {
    const prefilled = 'prefilledVariables={{ Regoin: "eu-west-1" }}'
    const said =
      'the `prefilledVariables` prop of <Inputs>: "Regoin" is no field of the form (did you mean "Region"?)'
    expect(
      await openErrors(CONFIG.replace('<Inputs id="config">', `<Inputs id="config" ${prefilled}>`)),
    ).toEqual([["config", [["badProp", 1, said]]]])
    expect(
      await openErrors(`<Inputs id="config" path="vars.yml" ${prefilled} />`, {
        "vars.yml": "variables: [{ name: Region }]",
      }),
    ).toEqual([["config", [["badProp", 1, said]]]])
  })

  it("refuses each malformed setting, at its own line, naming the field (H2)", async () => {
    const yaml = [
      "variables:",
      "  - name: Region",
      "    order: first",
      "    x-locked: yes",
      "  - name: Region",
    ]
    expect(await openErrors(fenced('<Inputs id="config">', yaml))).toEqual([
      [
        "config",
        [
          [
            "badChildren",
            5,
            'The YAML in <Inputs> isn\'t valid: the `order` of the field "Region" must be a whole number, such as 2 (at variables.0.order).',
          ],
          [
            "badChildren",
            6,
            'The YAML in <Inputs> isn\'t valid: `x-locked` on the field "Region" must be true or false (at variables.0.x-locked).',
          ],
          [
            "badChildren",
            7,
            'The YAML in <Inputs> isn\'t valid: two fields are named "Region": each field needs a name of its own (at variables.1.name).',
          ],
        ],
      ],
    ])
    expect(
      await openErrors('<Inputs id="config" path="vars.yml" />', { "vars.yml": yaml.join("\n") }),
    ).toEqual([
      [
        "config",
        [
          [
            "badProp",
            1,
            'vars.yml, line 3: the `order` of the field "Region" must be a whole number, such as 2. vars.yml, line 4: `x-locked` on the field "Region" must be true or false. vars.yml, line 5: two fields are named "Region": each field needs a name of its own.',
          ],
        ],
      ],
    ])
  })

  it("holds each block that reads it while it has a configuration error", async () => {
    const runbook = [
      fenced('<Inputs id="config">', ["variables:", "  - name: Region", "    x-hidden: 1"]),
      '<Echo id="deploy" inputsId="config" />',
    ].join("\n\n")
    await withSession(runbook, (s) =>
      Effect.gen(function* () {
        expect(yield* s.status("config")).toEqual({ _tag: "Misconfigured" })
        expect(yield* s.status("deploy")).toEqual({
          _tag: "Blocked",
          by: [{ _tag: "WaitingFor", block: blockId("config"), capability: "values" }],
        })
        expect(yield* s.client.RunBlock({ session: s.session, block: blockId("deploy") })).toEqual({
          _tag: "Refused",
          reason: {
            _tag: "Blocked",
            by: [{ _tag: "WaitingFor", block: blockId("config"), capability: "values" }],
          },
        })
      }),
    )
  })

  it("takes its YAML or a `path`: one of them, and only the YAML in a fence inside it", async () => {
    const neither =
      "<Inputs> has no YAML inside it: write the form's variables in a ```yaml code fence inside the block, or set `path`, a boilerplate.yml or the folder that holds one."
    expect(await openErrors('<Inputs id="config" />')).toEqual([
      ["config", [["badChildren", 1, neither]]],
    ])
    // Unfenced, the YAML is markdown, as today's app says.
    expect(await openErrors('<Inputs id="config">\nvariables:\n  - name: a\n</Inputs>')).toEqual([
      ["config", [["badChildren", 1, neither]]],
    ])
    // YAML that doesn't parse is the one error: the block has YAML, at fault.
    expect(
      await openErrors(
        fenced('<Inputs id="config">', ["variables:", "  - name: a", "  b", "    - c"]),
      ),
    ).toEqual([
      [
        "config",
        [["badChildren", 5, "The YAML in <Inputs> isn't valid: the indentation doesn't line up."]],
      ],
    ])
    expect(
      await openErrors(
        CONFIG.replace('<Inputs id="config">', '<Inputs id="config" path="vars.yml">'),
        {
          "vars.yml": "variables: []",
        },
      ),
    ).toEqual([
      [
        "config",
        [
          [
            "badProp",
            1,
            "the `path` prop of <Inputs>: set `path` or write the variables in a ```yaml code fence inside the block, not both",
          ],
        ],
      ],
    ])
    const warnings = await withSession(
      '<Inputs id="config" yaml={{ variables: [] }} path="vars.yml" />',
      (s) => Effect.succeed(s.warnings.map((w) => w.message)),
      { "vars.yml": "variables: [{ name: a }]" },
    )
    expect(warnings).toEqual([
      "<Inputs> takes its YAML only in a ```yaml code fence inside it, so the `yaml` prop is ignored.",
    ])
  })

  it("gives its readers its starting values until its first Submit, then each change, live (H1)", async () => {
    const runbook = [CONFIG, '<Echo id="deploy" inputsId="config" />'].join("\n\n")
    const runs = await withSession(runbook, (s) =>
      Effect.gen(function* () {
        yield* s.set("config", { Region: "eu-west-1" })
        expect(yield* s.shown("deploy")).toBe("Region=us-east-1 Count=3")
        yield* s.run("deploy")
        expect(yield* s.submit("config")).toEqual({ _tag: "Submitted" })
        expect(yield* s.shown("deploy")).toBe("Region=eu-west-1 Count=3")
        yield* s.set("config", { Region: "ap-south-1" })
        expect(yield* s.shown("deploy")).toBe("Region=ap-south-1 Count=3")
        yield* s.run("deploy")
        return s.runs
      }),
    )
    expect(runs).toEqual([
      { Region: "us-east-1", Count: 3 },
      { Region: "ap-south-1", Count: 3 },
    ])
  })

  it("holds a reader on a required field empty to start with until a Submit, then gives it only valid values", async () => {
    const runbook = [
      fenced('<Inputs id="config">', [
        "variables:",
        "  - name: Name",
        "    validations: [required, { type: regex, args: ['^[a-z]+$'] }]",
      ]),
      '<Echo id="deploy" inputsId="config" />',
    ].join("\n\n")
    await withSession(runbook, (s) =>
      Effect.gen(function* () {
        const held: BlockStatus = {
          _tag: "Blocked",
          by: [{ _tag: "WaitingFor", block: blockId("config"), capability: "values" }],
        }
        expect(yield* s.status("deploy")).toEqual(held)
        yield* s.set("config", { Name: "web" })
        expect(yield* s.status("deploy")).toEqual(held)
        expect(yield* s.submit("config")).toEqual({ _tag: "Submitted" })
        expect(yield* s.status("deploy")).toEqual({ _tag: "Idle" })
        expect(yield* s.shown("deploy")).toBe("Name=web")
        // A value that fails its validation reaches no reader.
        yield* s.set("config", { Name: "Not Valid" })
        expect(yield* s.shown("deploy")).toBe("Name=")
        expect(yield* s.status("deploy")).toEqual(held)
      }),
    )
  })

  it("inside a task, is the task's own form: no step, no Submit, its values live", async () => {
    const runbook = [
      '<Echo id="deploy">',
      "",
      fenced('<Inputs id="own">', ["variables:", "  - name: Region", "    default: us-east-1"]),
      "",
      "</Echo>",
      "",
      '<Echo id="later" inputsId="own" />',
    ].join("\n")
    await withSession(runbook, (s) =>
      Effect.gen(function* () {
        const own = s.blocks.find((block) => block.id === "own")
        expect(own).toMatchObject({ class: "form", step: false, nestedIn: 0 })
        yield* s.set("own", { Region: "eu-west-1" })
        expect(yield* s.shown("deploy")).toBe("Region=eu-west-1")
        // Another block that reads it gets its values live too, as today.
        expect(yield* s.shown("later")).toBe("Region=eu-west-1")
      }),
    )
  })

  it("registers the first of two forms with one id: the second is misconfigured, and readers get the first", async () => {
    const runbook = [
      CONFIG,
      fenced('<Inputs id="config">', ["variables:", "  - name: Other", "    default: x"]),
      '<Echo id="deploy" inputsId="config" />',
    ].join("\n\n")
    await withSession(runbook, (s) =>
      Effect.gen(function* () {
        expect(errorsOf(s.blocks)).toEqual([
          [
            "config",
            [
              [
                "duplicateId",
                12,
                '<Inputs> on line 1 already has the id "config". Each block needs its own id.',
              ],
            ],
          ],
        ])
        expect(yield* s.shown("deploy")).toBe("Region=us-east-1 Count=3")
      }),
    )
  })
})
