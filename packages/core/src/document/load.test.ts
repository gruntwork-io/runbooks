import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { hashTemplateDir } from "../domain/boilerplate/templateHash.ts"
import { FileNotFoundError } from "../errors/index.ts"
import { FileSystem } from "../services/FileSystem.ts"
import { makeTestFileSystem } from "../test-utils/TestFileSystem.ts"
import { TOY_REGISTRY } from "../test-utils/toyRegistry.ts"
import { configErrors, type ParseResult, type RunbookDocument } from "./document.ts"
import { loadRunbook } from "./load.ts"
import { parseRunbook } from "./parse.ts"

const RUNBOOK = "/rb/runbook.mdx"

/** Loads `/rb/runbook.mdx` from an in-memory folder holding `files`, with `dirs` as folders. */
const load = (
  files: Record<string, string>,
  dirs: ReadonlyArray<string> = [],
  realpaths: Readonly<Record<string, string>> = {},
): Promise<ParseResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem
      for (const dir of ["/rb", ...dirs]) yield* fs.mkdir(dir)
      const linked = {
        ...fs,
        realpath: (path: string) =>
          realpaths[path] === undefined ? fs.realpath(path) : Effect.succeed(realpaths[path]),
      }
      return yield* loadRunbook(RUNBOOK, TOY_REGISTRY, { appVersion: "0.31.0" }).pipe(
        Effect.provideService(FileSystem, linked),
      )
    }).pipe(Effect.provide(makeTestFileSystem(files))),
  )

const loaded = async (...args: Parameters<typeof load>): Promise<RunbookDocument> => {
  const result = await load(...args)
  if (result._tag === "Invalid") throw new Error(result.errors.map((e) => e.message).join("\n"))
  return result.document
}

/** Every configuration error, whether it refuses the runbook or stops one block. */
const refused = async (...args: Parameters<typeof load>) => {
  const result = await load(...args)
  return configErrors(result).map((e) => ({
    code: e.code,
    file: e.location.file,
    line: e.location.span.start.line,
    prop: e.location.prop,
    message: e.message,
  }))
}

const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`

/** Each file's path and hash, as strings. */
const fileHashes = (doc: RunbookDocument) =>
  Object.entries(doc.hash.files).map(([path, hash]) => [path, String(hash)])

describe("loadRunbook", () => {
  it("hashes each file a block names, and the combined hash changes with it", async () => {
    const runbook = '<Command id="a" path="scripts/a.sh" />'
    const before = await loaded({ [RUNBOOK]: runbook, "/rb/scripts/a.sh": "echo hi\n" })
    expect(fileHashes(before)).toEqual([["scripts/a.sh", sha256("echo hi\n")]])
    expect(String(before.hash.runbook)).toBe(sha256(runbook))

    const after = await loaded({ [RUNBOOK]: runbook, "/rb/scripts/a.sh": "echo bye\n" })
    expect(after.hash.runbook).toBe(before.hash.runbook)
    expect(after.hash.combined).not.toBe(before.hash.combined)
  })

  it("hashes a folder as the template hash does, and reads the template references in its files", async () => {
    const files = {
      [RUNBOOK]:
        '<Command id="setup" command="make" outputs={["region"]} />\n\n<Command id="plan" path="templates" />',
      "/rb/templates/main.tf": 'provider "aws" {}\nregion = "{{ .outputs.setup.region }}"\n',
      "/rb/templates/modules/vars.tf": "variable x {}\n",
    }
    const dirs = ["/rb/templates", "/rb/templates/modules"]
    const doc = await loaded(files, dirs)
    const folderHash = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem
        for (const dir of dirs) yield* fs.mkdir(dir)
        return yield* hashTemplateDir("/rb/templates")
      }).pipe(Effect.provide(makeTestFileSystem({ ...files }))),
    )
    expect(fileHashes(doc)).toEqual([["templates", `sha256:${folderHash}`]])
    expect(doc.edges).toEqual([
      {
        from: 1,
        to: 0,
        source: { _tag: "Template", key: "region", guarded: false },
        file: "/rb/templates/main.tf",
        // The reference itself, `.outputs.setup.region`, as the extractor spans it.
        span: { start: { line: 2, column: 14 }, end: { line: 2, column: 35 } },
      },
    ])
  })

  it("reports a template reference in a file at its line in that file, after the runbook's errors", async () => {
    expect(
      await refused({
        [RUNBOOK]:
          '<Command id="ship" path="scripts/ship.sh" />\n\n<Command id="other" command="ls" dependsOn={["nowhere"]} />',
        "/rb/scripts/ship.sh": "#!/bin/bash\ncp {{ .outputs.biuld.path }} out\n",
      }),
    ).toEqual([
      {
        code: "missingReference",
        file: RUNBOOK,
        line: 3,
        prop: "dependsOn",
        message: '`dependsOn` on <Command id="other"> names "nowhere", and no block has that id.',
      },
      {
        code: "missingReference",
        file: "/rb/scripts/ship.sh",
        line: 2,
        prop: "path",
        message:
          'scripts/ship.sh, a file <Command id="ship"> names, reads {{ .outputs.biuld.path }}, and no block has the id "biuld".',
      },
    ])
  })

  it("stops only the block whose file doesn't exist; the runbook opens", async () => {
    const result = await load({
      [RUNBOOK]:
        '<Command id="missing" path="scripts/missing.sh" />\n\n<Command id="working" path="scripts/ok.sh" />',
      "/rb/scripts/ok.sh": "echo ok\n",
    })
    if (result._tag === "Invalid") throw new Error("refused")
    expect(result.document.blocks.map((b) => [b.idAsWritten, b.errors.map((e) => e.code)])).toEqual(
      [
        ["missing", ["badFile"]],
        ["working", []],
      ],
    )
    expect(fileHashes(result.document)).toEqual([["scripts/ok.sh", sha256("echo ok\n")]])
  })

  it("refuses a file that doesn't exist, at the prop that names it", async () => {
    expect(await refused({ [RUNBOOK]: '<Command id="a" path="scripts/missing.sh" />' })).toEqual([
      {
        code: "badFile",
        file: RUNBOOK,
        line: 1,
        prop: "path",
        message:
          "`path` on <Command id=\"a\"> names scripts/missing.sh, which doesn't exist. The path is relative to the runbook's folder.",
      },
    ])
  })

  it.each([
    ["a parent folder", "../secret.sh"],
    ["an absolute path", "/etc/passwd"],
    ["a symbolic link", "scripts/link.sh"],
  ])("refuses a file outside the runbook's folder, through %s", async (_, path) => {
    const found = await refused(
      {
        [RUNBOOK]: `<Command id="a" path="${path}" />`,
        "/secret.sh": "x",
        "/etc/passwd": "x",
        "/rb/scripts/link.sh": "x",
      },
      [],
      { "/rb/scripts/link.sh": "/elsewhere/link.sh" },
    )
    expect(found).toEqual([
      {
        code: "badFile",
        file: RUNBOOK,
        line: 1,
        prop: "path",
        message: `\`path\` on <Command id="a"> names ${path}, which is outside the runbook's folder. A block can only name files in its runbook's folder.`,
      },
    ])
  })

  it("fails only when the runbook itself can't be read", async () => {
    const failure = await Effect.runPromise(
      loadRunbook(RUNBOOK, TOY_REGISTRY, { appVersion: "0.31.0" }).pipe(
        Effect.flip,
        Effect.provide(makeTestFileSystem({})),
      ),
    )
    expect(failure).toBeInstanceOf(FileNotFoundError)
  })
})

describe("parseRunbook without the files", () => {
  it("stops a block that names a file, so no block runs a file the hash leaves out", () => {
    const result = parseRunbook('<Command id="a" path="a.sh" />', TOY_REGISTRY, {
      file: "runbook.mdx",
      appVersion: "0.31.0",
    })
    if (result._tag === "Invalid") throw new Error("refused")
    expect(result.document.blocks[0]?.errors.map((e) => e.message)).toEqual([
      '`path` on <Command id="a"> names a.sh, which was not read. Load the runbook with loadRunbook, which reads the files its blocks name.',
    ])
    expect(fileHashes(result.document)).toEqual([])
  })
})
