import { describe, expect, expectTypeOf, it } from "bun:test"
import { Cause, Context, DateTime, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { Rpc, type RpcClient, RpcTest } from "effect/rpc"
import { BlockId, type Instruction as ContractInstruction } from "@runbooks/blocks-core/contract"
import { MAX_VALUE_DEPTH } from "@runbooks/blocks-core/form"
import { type CredentialStateTag, TRANSITIONS } from "../credential/lifecycle.ts"
import { ConfigError } from "../document/configError.ts"
import { ContentHash } from "../document/document.ts"
import { RUNBOOK_FILE_LIMITS } from "../document/files.ts"
import {
  ActResult,
  BASELINE_MCP_TOOLS,
  BlockView,
  Caller,
  CallerMiddleware,
  ChangeSettings,
  DocumentBlock,
  DocumentView,
  type EngineCommand,
  type EngineEvent,
  EngineProtocol,
  EventEnvelope,
  Events,
  FieldView,
  GetScriptFiles,
  type Instruction,
  type FileChange,
  Forbidden,
  LIMITS,
  OpenSession,
  type Origin,
  ReloadFiles,
  ReloadFilesResult,
  RunBlock,
  RunId,
  RunResult,
  ScriptFiles,
  SessionId,
  SessionView,
  SetValues,
  Settings,
  SettingsView,
  UnknownSequence,
  UnknownSession,
  WaitForBlock,
  type WatchMode,
} from "./protocol.ts"

const session = Schema.decodeUnknownSync(SessionId)("s1")
const greet = Schema.decodeUnknownSync(BlockId)("greet")
const config = Schema.decodeUnknownSync(BlockId)("config")
const hash = Schema.decodeUnknownSync(ContentHash)(`sha256:${"a".repeat(64)}`)
const at = DateTime.makeUnsafe("2026-11-24T12:00:00Z")

const unused = () => Effect.die("not used in this test")

/** A stand-in engine: just enough to show each kind of answer crossing the protocol. */
const Handlers = EngineProtocol.toLayer({
  OpenSession: unused,
  CloseSession: unused,
  ListSessions: unused,
  GetSession: unused,
  GetDocument: unused,
  TrustSession: () =>
    Effect.gen(function* () {
      const { origin } = yield* Caller
      if (origin === "agent") return yield* new Forbidden({ command: "TrustSession", origin })
      return { _tag: "Trusted" as const }
    }),
  Events: () =>
    Stream.make(
      {
        session,
        sequence: 0,
        at,
        event: { _tag: "TrustChanged" as const, trust: { trusted: true, hash } },
      },
      {
        session,
        sequence: 1,
        at,
        event: {
          _tag: "BlockStatusChanged" as const,
          block: greet,
          status: { _tag: "Running" as const },
        },
      },
    ),
  GetBlock: unused,
  GetScriptFiles: unused,
  SetValues: unused,
  ConfirmValues: unused,
  RunBlock: ({ session: id }) =>
    id === session
      ? Effect.succeed({
          _tag: "Refused" as const,
          reason: {
            _tag: "NeedsReview" as const,
            form: config,
            fields: [],
            unreviewed: ["Name"] as const,
          },
        })
      : Effect.fail(new UnknownSession({ session: id })),
  CancelBlock: unused,
  ResetBlock: unused,
  ReloadFiles: unused,
  WaitForBlock: unused,
  GetOutputs: unused,
  ActOnCredential: unused,
  ResolveApproval: unused,
  GetSettings: unused,
  ChangeSettings: unused,
  WatchSettings: () => Stream.die("not used in this test"),
})

/** What each transport does: say who is calling. */
const callerIs = (origin: Origin) =>
  Layer.succeed(CallerMiddleware)((effect) => Effect.provideService(effect, Caller, { origin }))

const withClient = <A, E>(
  origin: Origin,
  use: (client: RpcClient.RpcClient<EngineCommand>) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    RpcTest.makeClient(EngineProtocol).pipe(
      Effect.flatMap(use),
      Effect.scoped,
      Effect.provide(Layer.merge(Handlers, callerIs(origin))),
    ),
  )

describe("engine protocol", () => {
  it("decodes a command on arrival and names the field that is wrong", () => {
    expect(() =>
      Schema.decodeUnknownSync(RunBlock.payloadSchema)({ session: "s1", block: 5 }),
    ).toThrow(/at \["block"\]/)
    expect(() =>
      Schema.decodeUnknownSync(WaitForBlock.payloadSchema)({
        session: "s1",
        block: "greet",
        timeoutMillis: 600_000,
      }),
    ).toThrow(/at \["timeoutMillis"\]/)
  })

  it("refuses a SetValues value nested deeper than a form's values may be, as a malformed command, not a defect", () => {
    // An untyped caller's JSON, as the server decodes it: MCP sends what an agent wrote.
    const set = Schema.decodeUnknownExit(Schema.toCodecJson(SetValues.payloadSchema))
    let deep: unknown = "x"
    for (let level = 0; level < 10_000; level++) deep = [deep]
    const exit = set({ session: "s1", block: "config", values: { regions: deep } })
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
    expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain(
      `Expected a value nested at most ${MAX_VALUE_DEPTH} levels deep`,
    )
    expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain(
      'at ["values"]["regions"]',
    )
    const atBound: { regions: unknown } = { regions: "x" }
    for (let level = 0; level < MAX_VALUE_DEPTH; level++) atBound.regions = [atBound.regions]
    expect(Exit.isSuccess(set({ session: "s1", block: "config", values: atBound }))).toBe(true)
  })

  it("takes a runbook only by an absolute path, since its folder is a root", () => {
    const open = Schema.decodeUnknownSync(OpenSession.payloadSchema)
    for (const path of ["/rb/runbook.mdx", "C:\\rb\\runbook.mdx", "C:/rb/runbook.mdx"])
      expect(open({ path })).toEqual({ path })
    for (const path of ["rb/runbook.mdx", "./runbook.mdx", "C:runbook.mdx"])
      expect(() => open({ path })).toThrow(/Expected an absolute path/)
  })

  it("opens a session watching what its mode says, one of four", () => {
    const open = Schema.decodeUnknownSync(Schema.toCodecJson(OpenSession.payloadSchema))
    const path = "/rb/runbook.mdx"
    expect(open({ path })).toEqual({ path })
    for (const watch of ["off", "notice", "runbook", "runbookAndFiles"] as const)
      expect(open({ path, watch })).toEqual({ path, watch })
    expect(() => open({ path, watch: "always" })).toThrow(/at \["watch"\]/)
    expectTypeOf<WatchMode>().toEqualTypeOf<"off" | "notice" | "runbook" | "runbookAndFiles">()
  })

  it("answers an expected outcome in the success channel and a fault as a typed error", async () => {
    const refused = await withClient("agent", (client) =>
      client.RunBlock({ session, block: greet }),
    )
    expect(refused).toEqual({
      _tag: "Refused",
      reason: { _tag: "NeedsReview", form: config, fields: [], unreviewed: ["Name"] },
    })
    const fault = await withClient("agent", (client) =>
      client
        .RunBlock({ session: Schema.decodeUnknownSync(SessionId)("gone"), block: greet })
        .pipe(Effect.flip),
    )
    expect(fault._tag).toBe("UnknownSession")
  })

  it("takes the caller's origin from the transport, so an agent cannot trust a session", async () => {
    const trust = (origin: Origin) =>
      withClient(origin, (client) =>
        client.TrustSession({ session, hash }).pipe(
          Effect.map((r) => r._tag),
          Effect.catchTag("Forbidden", (e) => Effect.succeed(`Forbidden(${e.origin})`)),
        ),
      )
    expect(await trust("person")).toBe("Trusted")
    expect(await trust("agent")).toBe("Forbidden(agent)")
  })

  it("streams events in a session envelope", async () => {
    const events = await withClient("person", (client) =>
      client.Events({ session }).pipe(Stream.runCollect),
    )
    expect(Array.from(events, (e) => [e.sequence, e.event._tag])).toEqual([
      [0, "TrustChanged"],
      [1, "BlockStatusChanged"],
    ])
  })

  it("carries an event through JSON, as IPC and MCP do", () => {
    const json = Schema.toCodecJson(EventEnvelope)
    const envelope: EventEnvelope = {
      session,
      sequence: 3,
      at,
      event: {
        _tag: "OutputsPublished",
        block: greet,
        outputs: { greeting: { _tag: "Shown", value: "hi" }, token: { _tag: "Hidden" } },
      },
    }
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(json)(envelope)))
    expect(wire.at).toBe("2026-11-24T12:00:00.000Z")
    expect(wire.event.outputs.token).toEqual({ _tag: "Hidden" })
    expect(Schema.decodeUnknownSync(json)(wire)).toEqual(envelope)
  })

  it("says which input a blocked block waits for a value of, and the form that holds it, through JSON", () => {
    const json = Schema.toCodecJson(EventEnvelope)
    const envelope: EventEnvelope = {
      session,
      sequence: 5,
      at,
      event: {
        _tag: "BlockStatusChanged",
        block: greet,
        status: { _tag: "Blocked", by: [{ _tag: "EmptyInput", block: config, input: "tags.env" }] },
      },
    }
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(json)(envelope)))
    expect(wire.event.status.by).toEqual([
      { _tag: "EmptyInput", block: "config", input: "tags.env" },
    ])
    expect(Schema.decodeUnknownSync(json)(wire)).toEqual(envelope)
  })

  it("says which running block a blocked block waits for, and which of the two runs alone, through JSON", () => {
    const json = Schema.toCodecJson(EventEnvelope)
    const envelope: EventEnvelope = {
      session,
      sequence: 6,
      at,
      event: {
        _tag: "BlockStatusChanged",
        block: greet,
        status: {
          _tag: "Blocked",
          by: [
            { _tag: "Exclusive", block: config, runsAlone: "running" },
            { _tag: "Exclusive", block: config, runsAlone: "waiting" },
          ],
        },
      },
    }
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(json)(envelope)))
    expect(wire.event.status.by).toEqual([
      { _tag: "Exclusive", block: "config", runsAlone: "running" },
      { _tag: "Exclusive", block: "config", runsAlone: "waiting" },
    ])
    expect(Schema.decodeUnknownSync(json)(wire)).toEqual(envelope)
    expect(() =>
      Schema.decodeUnknownSync(json)({
        ...wire,
        event: {
          ...wire.event,
          status: {
            _tag: "Blocked",
            by: [{ _tag: "Exclusive", block: "config", runsAlone: "both" }],
          },
        },
      }),
    ).toThrow(/at \["event"\]\["status"\]\["by"\]\[0\]/)
  })

  it("holds a log line to 16384 characters, in an event and in a block's log page", () => {
    const json = Schema.toCodecJson(EventEnvelope)
    const run = Schema.decodeUnknownSync(RunId)("r1")
    const logged = (text: string): EventEnvelope => ({
      session,
      sequence: 4,
      at,
      event: {
        _tag: "LogLines",
        block: greet,
        run,
        offset: 0,
        lines: [{ stream: "stdout", text }],
      },
    })
    const longest = logged("x".repeat(16_384))
    expect(Schema.decodeUnknownSync(json)(Schema.encodeSync(json)(longest))).toEqual(longest)
    expect(() => Schema.encodeSync(json)(logged("x".repeat(16_385)))).toThrow(
      /at \["event"\]\["lines"\]\[0\]\["text"\]/,
    )
    const view = Schema.decodeUnknownSync(BlockView)
    const base = { block: greet, tag: "Run", class: "task", actions: [], outputs: {} }
    const page = (text: string) => ({ offset: 0, total: 1, lines: [{ stream: "stderr", text }] })
    expect(view({ ...base, log: page("x".repeat(16_384)) }).log?.lines[0]?.text).toHaveLength(
      16_384,
    )
    expect(() => view({ ...base, log: page("x".repeat(16_385)) })).toThrow(
      /at \["log"\]\["lines"\]\[0\]\["text"\]/,
    )
    expect(LIMITS.maxLogLineLength).toBe(16_384)
  })

  it("carries Events' refusal of a sequence not logged through JSON, as the typed error", () => {
    // A stream's error crosses in the exit that ends it.
    const json = Schema.toCodecJson(Rpc.exitSchema(Events))
    const refused = new UnknownSequence({ session, after: 5, next: 2 })
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(json)(Exit.fail(refused))))
    const back = Schema.decodeUnknownSync(json)(wire)
    expect(Exit.isFailure(back) && Cause.findErrorOption(back.cause)).toEqual(Option.some(refused))
  })

  it("carries the contract's instruction, every kind of step, through JSON", () => {
    expectTypeOf<Instruction>().toEqualTypeOf<ContractInstruction>()
    const json = Schema.toCodecJson(BlockView)
    const view: BlockView = {
      block: greet,
      tag: "Run",
      class: "task",
      actions: [],
      outputs: {},
      instruction: [
        { kind: "text", markdown: "Run this command:" },
        { kind: "code", language: "bash", code: "echo hi" },
        { kind: "link", label: "The docs", url: "https://docs.example.com/" },
      ],
    }
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(json)(view)))
    expect(Schema.decodeUnknownSync(json)(wire)).toEqual(view)
  })

  it("lists the files a block's run touched by absolute path, up to a limit it says it reached", () => {
    const view = Schema.decodeUnknownSync(BlockView)
    const base = { block: greet, tag: "Run", class: "task", actions: [], outputs: {} }
    const files: ReadonlyArray<FileChange> = [
      { path: "/work/generated/main.tf", change: "created" },
      { path: "C:\\work\\generated\\old.tf", change: "deleted" },
    ]
    expect(view({ ...base, files }).files).toEqual(files)
    expect(view({ ...base, files, filesTruncated: true }).filesTruncated).toBe(true)
    expect(() => view({ ...base, files, filesTruncated: false })).toThrow(/at \["filesTruncated"\]/)
    expect(() =>
      view({ ...base, files: [{ path: "generated/main.tf", change: "created" }] }),
    ).toThrow(/Expected an absolute path/)
    const many = Array.from({ length: LIMITS.maxRunFiles + 1 }, (_, i) => ({
      path: `/work/generated/${i}`,
      change: "created",
    }))
    expect(() => view({ ...base, files: many })).toThrow(/at \["files"\]/)
  })

  it("says how the files a block names changed on disk, within a limit it says it reached, through JSON", () => {
    const json = Schema.toCodecJson(BlockView)
    const base = { block: "greet", tag: "Run", class: "task", actions: [], outputs: {} }
    const line = (kind: string, text: string) => ({ kind, text })
    const onDisk = {
      hash: `sha256:${"a".repeat(64)}`,
      files: [
        {
          _tag: "Changed",
          path: "greet.sh",
          change: "modified",
          hunks: [
            {
              heldLine: 1,
              diskLine: 1,
              lines: [
                line("context", "#!/bin/bash"),
                line("deletion", "echo script-before"),
                line("addition", "echo script-after"),
              ],
            },
          ],
        },
        {
          _tag: "Changed",
          path: "templates/main.tf",
          change: "created",
          hunks: [{ heldLine: 1, diskLine: 1, lines: [line("addition", 'resource "x" {}')] }],
        },
        { _tag: "Changed", path: "templates/old.tf", change: "deleted", hunks: [] },
        { _tag: "Unreadable", path: "templates/big.bin", reason: "It is over 1048576 bytes." },
      ],
    }
    const view = Schema.decodeUnknownSync(json)({ ...base, filesOnDisk: onDisk })
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(json)(view)))
    expect(wire.filesOnDisk).toEqual(onDisk)
    expect(Schema.decodeUnknownSync(json)(wire)).toEqual(view)

    const shown = (fields: Record<string, unknown>) => ({
      ...base,
      filesOnDisk: { ...onDisk, ...fields },
    })
    expect(Schema.decodeUnknownSync(json)(shown({ truncated: true })).filesOnDisk?.truncated).toBe(
      true,
    )
    expect(() => Schema.decodeUnknownSync(json)(shown({ truncated: false }))).toThrow(
      /at \["filesOnDisk"\]\["truncated"\]/,
    )
    expect(() => Schema.decodeUnknownSync(json)(shown({ files: [] }))).toThrow(
      /at \["filesOnDisk"\]\["files"\]/,
    )
    const ofLength = (length: number) =>
      shown({
        files: [
          {
            _tag: "Changed",
            path: "greet.sh",
            change: "modified",
            hunks: [
              {
                heldLine: 1,
                diskLine: 1,
                // 8 for the path, 2 for the "y" line, and 1 for this line's ending.
                lines: [line("deletion", "x".repeat(length - 11)), line("addition", "y")],
              },
            ],
          },
        ],
      })
    expect(LIMITS.maxDiffChars).toBe(65_536)
    expect(Schema.decodeUnknownSync(json)(ofLength(65_536)).filesOnDisk?.files[0]?._tag).toBe(
      "Changed",
    )
    expect(() => Schema.decodeUnknownSync(json)(ofLength(65_537))).toThrow(/at \["filesOnDisk"\]/)

    const events = Schema.toCodecJson(EventEnvelope)
    const changed: EventEnvelope = {
      session,
      sequence: 7,
      at,
      event: { _tag: "FilesOnDiskChanged", block: greet },
    }
    expect(
      Schema.decodeUnknownSync(events)(
        JSON.parse(JSON.stringify(Schema.encodeSync(events)(changed))),
      ),
    ).toEqual(changed)
  })

  it("counts every file and every line of a block's files on disk toward its limit, empty or not", () => {
    const decode = Schema.decodeUnknownSync(Schema.toCodecJson(BlockView))
    const onDisk = (files: ReadonlyArray<Record<string, unknown>>) => ({
      block: "greet",
      tag: "Run",
      class: "task",
      actions: [],
      outputs: {},
      filesOnDisk: { hash: `sha256:${"a".repeat(64)}`, files },
    })
    const blankLines = (count: number) => [
      {
        _tag: "Changed",
        path: "greet.sh",
        change: "modified",
        hunks: [
          {
            heldLine: 1,
            diskLine: 1,
            lines: Array.from({ length: count }, () => ({ kind: "addition", text: "" })),
          },
        ],
      },
    ]
    // 8 for the path, and 1 for each line's ending.
    expect(decode(onDisk(blankLines(65_528))).filesOnDisk?.files).toHaveLength(1)
    expect(() => decode(onDisk(blankLines(65_529)))).toThrow(/at \["filesOnDisk"\]/)

    const unreadable = Array.from({ length: 2_000 }, (_, index) => ({
      _tag: "Unreadable",
      path: `big/${String(index).padStart(4, "0")}.bin`,
      reason: "It is over 1048576 bytes.",
    }))
    expect(() => decode(onDisk(unreadable))).toThrow(/at \["filesOnDisk"\]/)
    const deleted = Array.from({ length: 6_000 }, (_, index) => ({
      _tag: "Changed",
      path: `old/${String(index).padStart(4, "0")}.tf`,
      change: "deleted",
      hunks: [],
    }))
    expect(() => decode(onDisk(deleted))).toThrow(/at \["filesOnDisk"\]/)
  })

  it("reloads a block's files by the hash its view shows, and answers each outcome through JSON", () => {
    const payload = Schema.decodeUnknownSync(Schema.toCodecJson(ReloadFiles.payloadSchema))
    const sent = { session: "s1", block: "greet", hash: `sha256:${"a".repeat(64)}` }
    expect(payload(sent)).toEqual({ session, block: greet, hash })
    const { hash: _, ...unhashed } = sent
    expect(() => payload(unhashed)).toThrow(/at \["hash"\]/)

    const json = Schema.toCodecJson(ReloadFilesResult)
    for (const result of [
      { _tag: "Reloaded" },
      { _tag: "NotShown" },
      { _tag: "Running", blocks: ["greet"] },
    ]) {
      const decoded = Schema.decodeUnknownSync(json)(result)
      expect(JSON.parse(JSON.stringify(Schema.encodeSync(json)(decoded)))).toEqual(result)
    }
    expect(() => Schema.decodeUnknownSync(json)({ _tag: "Running", blocks: [] })).toThrow(
      /at \["blocks"\]/,
    )

    // Person only, as TrustSession is.
    const errors = Schema.toCodecJson(ReloadFiles.errorSchema)
    const refused = { _tag: "Forbidden", command: "ReloadFiles", origin: "agent" }
    expect(
      JSON.parse(
        JSON.stringify(Schema.encodeSync(errors)(Schema.decodeUnknownSync(errors)(refused))),
      ),
    ).toEqual(refused)
  })

  it("reads a block's script files by path, with the hash of the document they are from, through JSON", () => {
    const payload = Schema.decodeUnknownSync(Schema.toCodecJson(GetScriptFiles.payloadSchema))
    expect(payload({ session: "s1", block: "greet" })).toEqual({ session, block: greet })
    expect(() => payload({ session: "s1" })).toThrow(/at \["block"\]/)

    const json = Schema.toCodecJson(ScriptFiles)
    const shell = { path: "greet.sh", language: "bash", text: "echo {{ .inputs.token }}\n" }
    const python = { path: "scripts/greet.py", language: "python3", text: "" }
    const read = { document: `sha256:${"a".repeat(64)}`, files: [shell, python] }
    const decoded = Schema.decodeUnknownSync(json)(read)
    expect(decoded.document).toBe(hash)
    expect(JSON.parse(JSON.stringify(Schema.encodeSync(json)(decoded)))).toEqual(read)
    expect(Schema.decodeUnknownSync(json)({ ...read, files: [] }).files).toEqual([])
    const { document: _, ...undrawn } = read
    expect(() => Schema.decodeUnknownSync(json)(undrawn)).toThrow(/at \["document"\]/)
    expect(() =>
      Schema.decodeUnknownSync(json)({ ...read, files: [shell, { ...python, path: "" }] }),
    ).toThrow(/at \["files"\]\[1\]\["path"\]/)
    const { language: _language, ...unnamed } = python
    expect(() => Schema.decodeUnknownSync(json)({ ...read, files: [unnamed] })).toThrow(
      /at \["files"\]\[0\]\["language"\]/,
    )

    // A person and an agent may both read them, as GetBlock.
    const errors = Schema.toCodecJson(GetScriptFiles.errorSchema)
    const unknown = { _tag: "UnknownBlock", session: "s1", block: "gone" }
    expect(
      JSON.parse(
        JSON.stringify(Schema.encodeSync(errors)(Schema.decodeUnknownSync(errors)(unknown))),
      ),
    ).toEqual(unknown)
    const refused = { _tag: "Forbidden", command: "GetScriptFiles", origin: "agent" }
    expect(Exit.isFailure(Schema.decodeUnknownExit(errors)(refused))).toBe(true)
  })

  it("holds a script file's text to its bytes in characters, refusing one longer, never cutting it", () => {
    expect<number>(LIMITS.maxScriptChars).toBe(RUNBOOK_FILE_LIMITS.fileBytes)
    const json = Schema.toCodecJson(ScriptFiles)
    const holding = (text: string) => ({
      document: `sha256:${"a".repeat(64)}`,
      files: [{ path: "greet.sh", language: "bash", text }],
    })
    const full = "x".repeat(LIMITS.maxScriptChars)
    expect(Schema.decodeUnknownSync(json)(holding(full)).files[0]?.text).toBe(full)
    expect(() => Schema.decodeUnknownSync(json)(holding(`${full}x`))).toThrow(
      /at \["files"\]\[0\]\["text"\]/,
    )
  })

  it("names a task's script files in its document, never their text", () => {
    const json = Schema.toCodecJson(DocumentView)
    const span = { start: { line: 3, column: 1 }, end: { line: 3, column: 30 } }
    const configured = {
      _tag: "Configured",
      index: 0,
      tag: "Run",
      block: "Run",
      class: "task",
      id: "greet",
      span,
      step: true,
      effects: ["process"],
      scriptFiles: ["greet.sh", "scripts/greet.py"],
    }
    const wire = {
      hash: `sha256:${"a".repeat(64)}`,
      tree: { type: "root", children: [{ type: "block", index: 0, children: [] }] },
      blocks: [configured],
      warnings: [],
    }
    const decoded = Schema.decodeUnknownSync(json)(wire)
    expect(JSON.parse(JSON.stringify(Schema.encodeSync(json)(decoded)))).toEqual(wire)
    // A name is a path, never a file's text: the window never gets the text from here.
    expect(() =>
      Schema.decodeUnknownSync(json)({
        ...wire,
        blocks: [{ ...configured, scriptFiles: [{ path: "greet.sh", text: "echo hi" }] }],
      }),
    ).toThrow(/at \["blocks"\]\[0\]\["scriptFiles"\]\[0\]/)
    expect(() =>
      Schema.decodeUnknownSync(json)({ ...wire, blocks: [{ ...configured, scriptFiles: [""] }] }),
    ).toThrow(/at \["blocks"\]\[0\]\["scriptFiles"\]\[0\]/)
    const { scriptFiles: _, ...scriptless } = configured
    expect(
      Schema.decodeUnknownSync(json)({ ...wire, blocks: [scriptless] }).blocks[0],
    ).not.toHaveProperty("scriptFiles")
  })

  it("says what a resumed session did not restore, and carries it through JSON", () => {
    const json = Schema.toCodecJson(SessionView)
    const view: SessionView = {
      session,
      name: "rb",
      path: "/rb/runbook.mdx",
      blocks: [],
      trust: { trusted: false, hash },
      warnings: [],
      resumed: {
        lastUsed: at,
        problems: [
          { _tag: "OlderVersion", version: 1, blocks: [greet] },
          { _tag: "RunbookChanged", blocks: [] },
        ],
      },
    }
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(json)(view)))
    expect(wire.resumed.lastUsed).toBe("2026-11-24T12:00:00.000Z")
    expect(Schema.decodeUnknownSync(json)(wire)).toEqual(view)
    const { resumed: _, ...started } = view
    expect(Schema.decodeUnknownSync(json)(Schema.encodeSync(json)(started))).toEqual(started)
    expect(() =>
      Schema.decodeUnknownSync(json)({
        ...wire,
        resumed: { ...wire.resumed, problems: [{ _tag: "Lost", blocks: [] }] },
      }),
    ).toThrow()
  })

  it("tells an empty field from one holding an empty string", () => {
    const json = Schema.toCodecJson(FieldView)
    const field = (value: Partial<FieldView>): FieldView => ({
      name: "port",
      type: "int",
      description: { type: "root", children: [] },
      required: false,
      sensitive: false,
      readOnly: false,
      validations: [],
      reviewed: false,
      unresolved: [],
      ...value,
    })
    const empty = JSON.parse(JSON.stringify(Schema.encodeSync(json)(field({}))))
    expect("value" in empty).toBe(false)
    expect(Schema.decodeUnknownSync(json)(empty)).toEqual(field({}))
    const blank = field({ type: "string", value: { _tag: "Shown", value: "" } })
    expect(Schema.decodeUnknownSync(json)(Schema.encodeSync(json)(blank))).toEqual(blank)
  })

  it("carries a form's sections in order, each saying whether it starts folded, and a field's description tree and entry schema, through JSON", () => {
    const json = Schema.toCodecJson(BlockView)
    const accounts: FieldView = {
      name: "accounts",
      type: "map",
      description: {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              { type: "text", value: "One entry per " },
              { type: "strong", children: [{ type: "text", value: "account" }] },
            ],
          },
        ],
      },
      required: false,
      sensitive: false,
      section: "Accounts",
      readOnly: false,
      validations: [],
      reviewed: false,
      unresolved: [],
      schema: { email: "string", id: "int" },
      schemaInstanceLabel: "Account name",
    }
    const view: BlockView = {
      block: config,
      tag: "Form",
      class: "form",
      actions: ["run", "setValues", "confirmValues"],
      outputs: {},
      fields: [accounts],
      sections: [
        { name: "Accounts", collapsed: false },
        { name: "Advanced", collapsed: true },
      ],
    }
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(json)(view)))
    expect(Schema.decodeUnknownSync(json)(wire)).toEqual(view)
    expect(() =>
      Schema.decodeUnknownSync(json)({ ...wire, sections: [{ name: "Advanced" }] }),
    ).toThrow(/at \["sections"\]\[0\]\["collapsed"\]/)
    expect(() =>
      Schema.decodeUnknownSync(json)({
        ...wire,
        fields: [{ ...wire.fields[0], schema: { id: "number" } }],
      }),
    ).toThrow(/at \["fields"\]\[0\]\["schema"\]\["id"\]/)
    // The window only walks a description: it never gets the text to parse.
    expect(() =>
      Schema.decodeUnknownSync(json)({
        ...wire,
        fields: [{ ...wire.fields[0], description: "One entry per **account**" }],
      }),
    ).toThrow(/at \["fields"\]\[0\]\["description"\]/)
  })

  it("says which task a nested form is the own form of, and that it is no step", () => {
    const json = Schema.toCodecJson(DocumentBlock)
    const span = { start: { line: 4, column: 1 }, end: { line: 9, column: 10 } }
    const nested: DocumentBlock = {
      _tag: "Configured",
      index: 1,
      tag: "Form",
      block: "Form",
      class: "form",
      id: config,
      span,
      step: false,
      effects: [],
      nestedIn: 0,
    }
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(json)(nested)))
    expect(Schema.decodeUnknownSync(json)(wire)).toEqual(nested)
    for (const refused of [{ step: true }, { class: "task", tag: "Run", block: "Run" }])
      expect(() => Schema.decodeUnknownSync(json)({ ...wire, ...refused })).toThrow(
        "Expected a form nested in a task to be a form that is no step",
      )
    const { nestedIn: _, ...placed } = wire
    expect(Schema.decodeUnknownSync(json)({ ...placed, step: true })).not.toHaveProperty("nestedIn")
  })

  it("answers a form's submit with no run to follow", () => {
    const json = Schema.toCodecJson(RunResult)
    expect(Schema.decodeUnknownSync(json)({ _tag: "Submitted" })).toEqual({ _tag: "Submitted" })
  })

  it("answers an action naming a target the block does not offer with what it does offer", () => {
    const json = Schema.toCodecJson(ActResult)
    const notOffered: ActResult = {
      _tag: "NotOffered",
      field: "id",
      value: "nope",
      offered: ["dev", "prod"],
    }
    expect(Schema.decodeUnknownSync(json)(notOffered)).toEqual(notOffered)
    expect(() => Schema.decodeUnknownSync(json)({ ...notOffered, field: "fields" })).toThrow()
  })

  it("says which state refused an action: a credential state, Blocked or Misconfigured, and nothing else", () => {
    const json = Schema.toCodecJson(ActResult)
    const states = [...Object.keys(TRANSITIONS), "Blocked", "Misconfigured"]
    for (const state of states) {
      const decoded: unknown = Schema.decodeUnknownSync(json)({ _tag: "NotAllowed", state })
      expect(decoded).toEqual({ _tag: "NotAllowed", state })
    }
    expect(() => Schema.decodeUnknownSync(json)({ _tag: "NotAllowed", state: "Asleep" })).toThrow()
    type State = Extract<ActResult, { _tag: "NotAllowed" }>["state"]
    expectTypeOf<State>().toEqualTypeOf<CredentialStateTag | "Blocked" | "Misconfigured">()
  })

  it("refuses a setting it does not have, naming each one, and a value a setting does not take", () => {
    // What a transport's server decodes the payload with (RpcServer reads the annotation).
    const options = Context.get(ChangeSettings.annotations, Rpc.ParseOptions)
    const change = (changes: unknown) =>
      Schema.decodeUnknownSync(ChangeSettings.payloadSchema)({ changes }, options)
    expect(change({ theme: "dark", caBundleFile: null })).toEqual({
      changes: { theme: "dark", caBundleFile: null },
    })
    expect(() => change({ theme: "dark", fontSize: 12, accent: "red" })).toThrow(
      /at \["changes"\]\["fontSize"\][\s\S]*at \["changes"\]\["accent"\]/,
    )
    expect(() => change({ theme: "purple" })).toThrow(/at \["changes"\]\["theme"\]/)
    expect(() => change({ caBundleFile: "certs/ca.pem" })).toThrow(/Expected an absolute path/)
    expect(() => change({ recentGitHubHosts: ["a", "b", "c", "d", "e", "f"] })).toThrow(
      /at \["changes"\]\["recentGitHubHosts"\]/,
    )
  })

  it("takes a proxy only as an http or https URL with no user name or password, and does not echo one", () => {
    const proxy = (value: string) =>
      Schema.decodeUnknownSync(Settings.fields.proxy)(value, { errors: "all" })
    for (const url of ["http://proxy.example.com:3128", "https://10.0.0.1:8443/"])
      expect(proxy(url)).toBe(url)
    expect(() => proxy("socks5://proxy:1080")).toThrow("Expected an http:// or https:// proxy URL.")
    expect(() => proxy("proxy.example.com")).toThrow("Expected a URL")
    expect(() => proxy("http://proxy:3128/path")).toThrow("no path")
    let message = ""
    try {
      proxy("http://me:hunter2@proxy:3128")
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain("may not hold a user name or password")
    expect(message).not.toContain("hunter2")
  })

  it("carries the settings through JSON, a setting with no value as null", () => {
    const json = Schema.toCodecJson(SettingsView)
    const view: SettingsView = {
      settings: {
        theme: "dark",
        instructionMode: false,
        runbookWidth: null,
        askAboutGeneratedFiles: true,
        caBundleFile: "/etc/corp/ca.pem",
        proxy: null,
        agentAccess: false,
        confirmAgentRuns: true,
        recentGitHubHosts: ["github.example.com"],
        lastSelectedGitHubHost: null,
        recentGitLabHosts: [],
        lastSelectedGitLabHost: "gitlab.example.com:8443",
      },
      file: "/data/settings.json",
      problems: [{ _tag: "Newer", version: 2 }],
    }
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(json)(view)))
    expect(wire.settings.proxy).toBeNull()
    expect(Schema.decodeUnknownSync(json)(wire)).toEqual(view)
  })

  it("carries a document through JSON: only JSON props, and a misconfigured block's errors", () => {
    const json = Schema.toCodecJson(DocumentView)
    const span = { start: { line: 3, column: 1 }, end: { line: 3, column: 30 } }
    const place = { tag: "Run", block: "Run", class: "task", span } as const
    const configured: DocumentBlock = {
      _tag: "Configured",
      index: 0,
      ...place,
      id: greet,
      title: "Greet",
      step: true,
      effects: ["process"],
      props: { command: "echo hi", args: ["-n", 1, true, null] },
    }
    const misconfigured: DocumentBlock = {
      _tag: "Misconfigured",
      index: 1,
      ...place,
      errors: [
        new ConfigError({
          code: "badProp",
          message: "`args` is not a list.",
          location: { file: "/rb/runbook.mdx", span, block: { tag: "Run" }, prop: "args" },
        }),
      ],
    }
    const document: DocumentView = {
      hash,
      title: "Deploy",
      tree: {
        type: "root",
        children: [
          { type: "heading", depth: 1, children: [{ type: "text", value: "Deploy" }] },
          { type: "block", index: 0, children: [] },
          { type: "block", index: 1, children: [] },
        ],
      },
      blocks: [configured, misconfigured],
      warnings: [],
    }
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(json)(document)))
    expect(Schema.decodeUnknownSync(json)(wire)).toEqual(document)

    expect(() =>
      Schema.encodeUnknownSync(json)({
        ...document,
        blocks: [{ ...configured, props: { at: new Date(0) } }],
      }),
    ).toThrow(/Expected JSON value/)
    const [, wireMisconfigured] = wire.blocks
    expect(() =>
      Schema.decodeUnknownSync(json)({
        ...wire,
        blocks: [wire.blocks[0], { ...wireMisconfigured, errors: [] }],
      }),
    ).toThrow(/at \["blocks"\]\[1\]/)
  })

  it("carries the hash of what a document holds, and refuses one without it", () => {
    const json = Schema.toCodecJson(DocumentView)
    const document: DocumentView = {
      hash,
      tree: { type: "root", children: [] },
      blocks: [],
      warnings: [],
    }
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(json)(document)))
    expect(wire.hash).toBe(`sha256:${"a".repeat(64)}`)
    expect(Schema.decodeUnknownSync(json)(wire)).toEqual(document)
    const { hash: _, ...unhashed } = wire
    expect(() => Schema.decodeUnknownSync(json)(unhashed)).toThrow(/at \["hash"\]/)
  })

  it("says the session reloaded its runbook, or why it holds a reload back, through JSON", () => {
    const json = Schema.toCodecJson(EventEnvelope)
    const invalid = new ConfigError({
      code: "syntax",
      message: "Expected a closing tag for `<Run>`.",
      location: {
        file: "/rb/runbook.mdx",
        span: { start: { line: 3, column: 1 }, end: { line: 3, column: 6 } },
      },
    })
    const events: ReadonlyArray<EngineEvent> = [
      { _tag: "DocumentChanged", hash },
      { _tag: "ReloadHeldChanged", held: { _tag: "Running", blocks: [greet] } },
      { _tag: "ReloadHeldChanged", held: { _tag: "Invalid", errors: [invalid], warnings: [] } },
      {
        _tag: "ReloadHeldChanged",
        held: { _tag: "Unreadable", message: "There is no file at /rb/runbook.mdx." },
      },
      { _tag: "ReloadHeldChanged" },
    ]
    for (const [sequence, event] of events.entries()) {
      const envelope: EventEnvelope = { session, sequence, at, event }
      const wire = JSON.parse(JSON.stringify(Schema.encodeSync(json)(envelope)))
      expect(Schema.decodeUnknownSync(json)(wire)).toEqual(envelope)
    }
    const running = { session, sequence: 0, at: "2026-11-24T12:00:00.000Z" }
    expect(() =>
      Schema.decodeUnknownSync(json)({
        ...running,
        event: { _tag: "ReloadHeldChanged", held: { _tag: "Running", blocks: [] } },
      }),
    ).toThrow(/at \["event"\]\["held"\]\["blocks"\]/)

    const view = Schema.toCodecJson(SessionView)
    const held: SessionView = {
      session,
      name: "rb",
      path: "/rb/runbook.mdx",
      blocks: [],
      trust: { trusted: true, hash },
      warnings: [],
      reloadHeld: { _tag: "Running", blocks: [greet] },
    }
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(view)(held)))
    expect(wire.reloadHeld).toEqual({ _tag: "Running", blocks: ["greet"] })
    expect(Schema.decodeUnknownSync(view)(wire)).toEqual(held)
  })

  it("says the session stopped watching, and why, through JSON", () => {
    const message =
      "Runbooks could not watch /rb/runbook.mdx for changes: ENOSPC: System limit for number of file watchers reached."
    const json = Schema.toCodecJson(EventEnvelope)
    const envelope: EventEnvelope = {
      session,
      sequence: 0,
      at,
      event: { _tag: "Unwatched", message },
    }
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(json)(envelope)))
    expect(wire.event).toEqual({ _tag: "Unwatched", message })
    expect(Schema.decodeUnknownSync(json)(wire)).toEqual(envelope)

    const view = Schema.toCodecJson(SessionView)
    const unwatched: SessionView = {
      session,
      name: "rb",
      path: "/rb/runbook.mdx",
      blocks: [],
      trust: { trusted: true, hash },
      warnings: [],
      unwatched: { message },
    }
    const viewWire = JSON.parse(JSON.stringify(Schema.encodeSync(view)(unwatched)))
    expect(viewWire.unwatched).toEqual({ message })
    expect(Schema.decodeUnknownSync(view)(viewWire)).toEqual(unwatched)
  })

  it("serves every baseline MCP tool with a command (decision 12)", () => {
    expect(Object.keys(BASELINE_MCP_TOOLS)).toHaveLength(10)
    for (const command of Object.values(BASELINE_MCP_TOOLS)) {
      expect(EngineProtocol.requests.has(command)).toBe(true)
    }
  })
})
