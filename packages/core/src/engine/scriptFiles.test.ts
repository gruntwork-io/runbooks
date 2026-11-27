/**
 * `GetScriptFiles` through the engine: the files a block runs as scripts,
 * as the session holds them, with the hash of the document they are from.
 * A file is rewritten in the test file system, as an editor saving it
 * would, and taken as the session's watcher and a person would take it.
 */
import { describe, expect, it } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { BlockId, defineTask, RunbookPath } from "@runbooks/blocks-core/contract"
import type { ContentHash } from "../document/document.ts"
import { FileSystem } from "../services/FileSystem.ts"
import { testCredentialProviders } from "../test-utils/TestCredentialProviders.ts"
import { testFileSystem } from "../test-utils/TestFileSystem.ts"
import { type Hold, makeHold } from "../test-utils/TestSessionDatabase.ts"
import { testSessionStore } from "../test-utils/TestSessionStore.ts"
import { testSettingsStore } from "../test-utils/TestSettingsFile.ts"
import { TOY_REGISTRY } from "../test-utils/toyRegistry.ts"
import { Engine } from "./engine.ts"
import { Caller } from "./protocol.ts"

const RUNBOOK = "/rb/runbook.mdx"
const blockId = Schema.decodeSync(BlockId)
const toPath = Schema.decodeSync(RunbookPath)

const ScriptProps = Schema.Struct({
  command: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(RunbookPath),
  teardown: Schema.optionalKey(RunbookPath),
  shell: Schema.optionalKey(Schema.String),
  inputsId: Schema.optionalKey(BlockId),
})

/** A task that runs its `command`, then the file its `path` names, then its `teardown` file, each written in its `shell`. */
const script = defineTask({
  name: "Script",
  since: "0.1.0",
  class: "task",
  props: ScriptProps,
  children: { kind: "none" },
  references: {},
  runbookFiles: (p) => [
    ...(p.path === undefined ? [] : [p.path]),
    ...(p.teardown === undefined ? [] : [p.teardown]),
  ],
  scripts: (p) => [
    ...(p.command === undefined ? [] : [{ _tag: "Prop", prop: "command" } as const]),
    ...(p.path === undefined ? [] : [{ _tag: "File", path: p.path } as const]),
    ...(p.teardown === undefined ? [] : [{ _tag: "File", path: p.teardown } as const]),
  ],
  scriptLanguage: (p, text) =>
    p.shell ?? (text.startsWith("#!/usr/bin/env python3") ? "python3" : "bash"),
  provides: ["run"],
  effects: ["process"],
  outputs: () => ({}),
  run: () => Stream.empty,
  instruction: () => [],
  plugins: [],
})

/** As `Script`, saying nothing of what its scripts are written in. */
const { scriptLanguage: _, ...saysNoLanguage } = script
const unnamed = defineTask({ ...saysNoLanguage, name: "Unnamed" })

/** As `Script`, with a run that never ends by itself and stops only once `stopping` is released, after saying it was asked to. */
const slowToStop = (stopping: Hold) =>
  defineTask({
    ...script,
    name: "Slow",
    run: () =>
      Stream.fromEffectDrain(
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.andThen(
              Deferred.succeed(stopping.reached, undefined),
              Deferred.await(stopping.release),
            ),
          ),
        ),
      ),
  })

/** The blocks a test's runbook may hold, its `Slow` stopping as `stopping` lets it. */
const registryWith = (stopping: Hold) => ({
  ...TOY_REGISTRY,
  Script: script,
  Unnamed: unnamed,
  Slow: slowToStop(stopping),
})

/** Runs `program` against an engine for a folder that holds `runbook` at `/rb/runbook.mdx` and `files`. */
const withEngine = <A, E>(
  runbook: string,
  program: Effect.Effect<A, E, Engine | Caller | FileSystem>,
  files: Readonly<Record<string, string>> = {},
  stopping: Hold = makeHold(),
): Promise<A> =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(
        Engine.layer({
          registry: registryWith(stopping),
          appVersion: "0.31.0",
          workingFolders: "/work",
          stateFolders: "/state",
          processEnvironment: {},
        }),
      ),
      Effect.provide(testCredentialProviders({}, [])),
      Effect.provide(testSettingsStore()),
      Effect.provide(testSessionStore()),
      Effect.provide(
        Layer.succeed(FileSystem, testFileSystem({ [RUNBOOK]: runbook, ...files }, ["/rb"])),
      ),
      Effect.provideService(Caller, { origin: "person" }),
    ),
  )

/** The commands a test sends to the runbook's session, opened now. */
const opened = Effect.gen(function* () {
  const engine = yield* Engine
  const files = yield* FileSystem
  const result = yield* engine.openSession({ path: RUNBOOK })
  if (result._tag !== "Opened") throw new Error(result.errors.map((e) => e.message).join("\n"))
  const { session, trust } = result.session
  const target = (block: string) => ({ session, block: blockId(block) })
  return {
    session,
    scriptFiles: (block: string) => engine.getScriptFiles(target(block)),
    block: (block: string) => engine.getBlock(target(block)),
    document: engine.getDocument({ session }),
    set: (block: string, values: Readonly<Record<string, string>>) =>
      engine.setValues({ ...target(block), values }),
    trust: engine.trustSession({ session, hash: trust.hash }),
    run: (block: string) => engine.runBlock(target(block)),
    cancel: (block: string) => engine.cancelBlock(target(block)),
    /** Saves `text` at `file`, as an editor would. */
    write: (file: string, text: string) => files.writeFile(file, text),
    /** Saves `text` as the runbook, then reloads the session as its watcher would, reading each file again. */
    save: (text: string) =>
      Effect.andThen(files.writeFile(RUNBOOK, text), engine.reloadRunbook(session, "read")),
    /** What the session's watcher does when files the runbook names change on disk. */
    seen: (...paths: ReadonlyArray<string>) =>
      engine.filesChanged(
        session,
        paths.map((path) => toPath(path)),
      ),
    reloadFiles: (block: string, hash: ContentHash) =>
      engine.reloadFiles({ ...target(block), hash }),
  }
})

const runbookOf = (...blocks: ReadonlyArray<string>) => blocks.join("\n\n")

/** The file at `path`, as `GetScriptFiles` gives it. */
const fileAt = (path: string, language: string, text: string) => ({
  path: toPath(path),
  language,
  text,
})

describe("a block's script files", () => {
  it("are the text the session holds of a file, while the file differs on disk, and the file's new text once a person reloads it", () =>
    withEngine(
      runbookOf('<Script id="deploy" path="deploy.sh" />'),
      Effect.gen(function* () {
        const rb = yield* opened
        const first = (yield* rb.document).hash
        const held = { document: first, files: [fileAt("deploy.sh", "bash", "echo v1\n")] }
        expect(yield* rb.scriptFiles("deploy")).toEqual(held)

        yield* rb.write("/rb/deploy.sh", "#!/usr/bin/env python3\nprint('v2')\n")
        yield* rb.seen("deploy.sh")
        const shown = (yield* rb.block("deploy")).filesOnDisk
        if (shown === undefined) throw new Error("deploy shows no files on disk")
        // The file on disk differs, and the session still holds the text it read.
        expect(yield* rb.scriptFiles("deploy")).toEqual(held)

        expect(yield* rb.reloadFiles("deploy", shown.hash)).toEqual({ _tag: "Reloaded" })
        const second = (yield* rb.document).hash
        expect(second).not.toBe(first)
        expect(yield* rb.scriptFiles("deploy")).toEqual({
          document: second,
          files: [fileAt("deploy.sh", "python3", "#!/usr/bin/env python3\nprint('v2')\n")],
        })
      }),
      { "/rb/deploy.sh": "echo v1\n" },
    ))

  it("give a file's `{{ }}` byte for byte, never rendered with the values it would read", () =>
    withEngine(
      runbookOf(
        ['<Form id="config">', "```yaml", "- name: token", "  type: string", "```", "</Form>"].join(
          "\n",
        ),
        '<Script id="greet" inputsId="config" path="greet.sh" />',
      ),
      Effect.gen(function* () {
        const rb = yield* opened
        yield* rb.set("config", { token: "tok-SECRET" })
        const { files } = yield* rb.scriptFiles("greet")
        expect(files.map(({ text }) => text)).toEqual([
          "echo {{ .inputs.token }} {{.inputs.token}}\n",
        ])
        expect(JSON.stringify(files)).not.toContain("tok-SECRET")
      }),
      { "/rb/greet.sh": "echo {{ .inputs.token }} {{.inputs.token}}\n" },
    ))

  it("are only files, in the block's order, never an inline script, which the document's props hold, and the document names each without its text", () =>
    withEngine(
      runbookOf(
        '<Script id="both" teardown="after.sh" command="echo inline" path="both.sh" shell="zsh" />',
        '<Unnamed id="plain" path="plain.sh" />',
        '<Script id="inline" command="echo inline" />',
      ),
      Effect.gen(function* () {
        const rb = yield* opened
        const document = yield* rb.document
        expect(yield* rb.scriptFiles("both")).toEqual({
          document: document.hash,
          files: [
            fileAt("both.sh", "zsh", "echo file\n"),
            fileAt("after.sh", "zsh", "echo after\n"),
          ],
        })
        // A block that says nothing of what its scripts are written in gives plain text.
        expect((yield* rb.scriptFiles("plain")).files).toEqual([
          fileAt("plain.sh", "text", "echo plain\n"),
        ])
        expect(yield* rb.scriptFiles("inline")).toEqual({ document: document.hash, files: [] })
        const [both, plain, inline] = document.blocks
        expect(both).toMatchObject({
          _tag: "Configured",
          scriptFiles: ["both.sh", "after.sh"],
          props: { command: "echo inline" },
        })
        expect(plain).toMatchObject({ scriptFiles: ["plain.sh"] })
        expect(inline).toMatchObject({ _tag: "Configured", props: { command: "echo inline" } })
        expect(inline).not.toHaveProperty("scriptFiles")
        expect(JSON.stringify(document.blocks)).not.toContain("echo file")
      }),
      {
        "/rb/both.sh": "echo file\n",
        "/rb/after.sh": "echo after\n",
        "/rb/plain.sh": "echo plain\n",
      },
    ))

  it("are none for a block that declares none, or one that is misconfigured, which the document names no files for", () =>
    withEngine(
      runbookOf(
        '<Run id="toy" command="echo toy" />',
        '<Script id="none" />',
        '<Script id="broken" path="broken.sh" shell={3} />',
      ),
      Effect.gen(function* () {
        const rb = yield* opened
        const document = yield* rb.document
        for (const block of ["toy", "none", "broken"])
          expect(yield* rb.scriptFiles(block)).toEqual({ document: document.hash, files: [] })
        expect(document.blocks.map((block) => block._tag)).toEqual([
          "Configured",
          "Configured",
          "Misconfigured",
        ])
        for (const block of document.blocks) expect(block).not.toHaveProperty("scriptFiles")
      }),
      { "/rb/broken.sh": "echo broken\n" },
    ))

  it("name a block the session lacks", () =>
    withEngine(
      runbookOf('<Script id="greet" command="echo hi" />'),
      Effect.gen(function* () {
        const rb = yield* opened
        expect(yield* Effect.flip(rb.scriptFiles("gone"))).toMatchObject({
          _tag: "UnknownBlock",
          session: rb.session,
          block: "gone",
        })
      }),
    ))

  it("come from the document the session holds now, by its hash, once it reloads its runbook", () =>
    withEngine(
      runbookOf('<Script id="greet" path="before.sh" />'),
      Effect.gen(function* () {
        const rb = yield* opened
        expect((yield* rb.scriptFiles("greet")).document).toBe((yield* rb.document).hash)
        yield* rb.write("/rb/added.sh", "echo added\n")
        yield* rb.save(
          runbookOf(
            '<Script id="greet" path="after.sh" />',
            '<Script id="added" path="added.sh" />',
          ),
        )
        const document = yield* rb.document
        expect(yield* rb.scriptFiles("greet")).toEqual({
          document: document.hash,
          files: [fileAt("after.sh", "bash", "echo after\n")],
        })
        // A file the reloaded runbook names first is named in its document and read as it holds it.
        expect(document.blocks[1]).toMatchObject({ scriptFiles: ["added.sh"] })
        expect((yield* rb.scriptFiles("added")).files).toEqual([
          fileAt("added.sh", "bash", "echo added\n"),
        ])
      }),
      { "/rb/before.sh": "echo before\n", "/rb/after.sh": "echo after\n" },
    ))

  it("are read while a locked operation waits, such as a stop waiting for its run to end", async () => {
    const stopping = makeHold()
    await withEngine(
      runbookOf('<Slow id="slow" path="slow.sh" />'),
      Effect.gen(function* () {
        const rb = yield* opened
        yield* rb.trust
        yield* rb.run("slow")
        const cancelling = yield* Effect.forkChild(rb.cancel("slow"))
        yield* Deferred.await(stopping.reached)
        // The stop holds the session's lock until its run ends.
        const read = yield* rb
          .scriptFiles("slow")
          .pipe(
            Effect.timeout("1 second"),
            Effect.ensuring(Deferred.succeed(stopping.release, undefined)),
          )
        expect(read.files).toEqual([fileAt("slow.sh", "bash", "echo slow\n")])
        expect(yield* Fiber.join(cancelling)).toBe("cancelled")
      }),
      { "/rb/slow.sh": "echo slow\n" },
      stopping,
    )
  })
})
