import { describe, expect, it } from "bun:test"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { type RpcClient, RpcTest } from "effect/rpc"
import { BlockId } from "@runbooks/blocks-core/contract"
import { ContentHash } from "../document/document.ts"
import {
  BASELINE_MCP_TOOLS,
  Caller,
  CallerMiddleware,
  type EngineCommand,
  EngineProtocol,
  EventEnvelope,
  FieldView,
  Forbidden,
  type Origin,
  RunBlock,
  SessionId,
  UnknownSession,
  WaitForBlock,
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
  WaitForBlock: unused,
  GetOutputs: unused,
  ActOnCredential: unused,
  ResolveApproval: unused,
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

  it("tells an empty field from one holding an empty string", () => {
    const json = Schema.toCodecJson(FieldView)
    const field = (value: Partial<FieldView>): FieldView => ({
      name: "port",
      type: "int",
      description: "",
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

  it("serves every baseline MCP tool with a command (decision 12)", () => {
    expect(Object.keys(BASELINE_MCP_TOOLS)).toHaveLength(10)
    for (const command of Object.values(BASELINE_MCP_TOOLS)) {
      expect(EngineProtocol.requests.has(command)).toBe(true)
    }
  })
})
