/**
 * The engine: owns every open session and serves the protocol's session
 * and block commands. It is headless; the app window, the CLI and MCP reach
 * it through a transport. The registry is passed in, so the core never
 * imports the blocks.
 */
import { Context, Effect, Layer, Schema, Stream } from "effect"
import type { Rpc } from "effect/rpc"
import type { PropError, TaskError, TaskEvent } from "@runbooks/blocks-core/contract"
import type { FormSpec } from "@runbooks/blocks-core/form"
import type { Registry, ServicesOf } from "@runbooks/blocks-core/registry"
import { loadRunbook } from "../document/load.ts"
import type { FileSystem } from "../services/FileSystem.ts"
import {
  type CancelBlock,
  Caller,
  type CloseSession,
  type EventEnvelope,
  type Events,
  Forbidden,
  type GetBlock,
  type GetOutputs,
  type GetSession,
  LIMITS,
  type ConfirmValues,
  type ListSessions,
  type OpenSession,
  type ResetBlock,
  type RunBlock,
  RunbookUnreadable,
  SessionId,
  type SetValues,
  type TrustSession,
  UnknownSession,
  type WaitForBlock,
} from "./protocol.ts"
import { makeSession, type ReadForm, type Session, type StartRun } from "./session.ts"

/** Serves one protocol command, with the command's own payload, success and error types. */
type Command<R extends Rpc.Any, Requires = never> = (
  payload: Rpc.Payload<R>,
) => Effect.Effect<Rpc.Success<R>, Rpc.Error<R>, Requires>

export interface EngineShape {
  readonly openSession: Command<typeof OpenSession>
  /** Interrupts the session's runs and ends its event streams. */
  readonly closeSession: Command<typeof CloseSession>
  readonly listSessions: Effect.Effect<Rpc.Success<typeof ListSessions>>
  readonly getSession: Command<typeof GetSession>
  /** Person only. */
  readonly trustSession: Command<typeof TrustSession, Caller>
  readonly events: (
    payload: Rpc.Payload<typeof Events>,
  ) => Stream.Stream<EventEnvelope, UnknownSession>
  readonly getBlock: Command<typeof GetBlock>
  /** Enters values as if typed. An agent's are reviewed; a value a person changes is not. */
  readonly setValues: Command<typeof SetValues, Caller>
  /** An agent's counts every field the form shows as reviewed, defaults included; a person's changes nothing. */
  readonly confirmValues: Command<typeof ConfirmValues, Caller>
  /** Runs a task or submits a form. An agent's is refused until every field it reads is reviewed. */
  readonly runBlock: Command<typeof RunBlock, Caller>
  readonly cancelBlock: Command<typeof CancelBlock>
  readonly resetBlock: Command<typeof ResetBlock>
  readonly waitForBlock: Command<typeof WaitForBlock>
  readonly getOutputs: Command<typeof GetOutputs>
}

export interface EngineOptions<R extends Registry> {
  readonly registry: R
  /** Checked against a runbook's `runbooks:` requirement. */
  readonly appVersion: string
}

const decodeSessionId = Schema.decodeSync(SessionId)

const unreadable = (file: string, message: string) =>
  Effect.fail(new RunbookUnreadable({ path: file, message }))

export class Engine extends Context.Service<Engine, EngineShape>()("@runbooks/core/engine/Engine") {
  /**
   * The engine for `registry`. It needs the services every block in the
   * registry asks for, and gives them to each run. Closing the layer closes
   * every session.
   */
  static readonly layer = <R extends Registry>(
    options: EngineOptions<R>,
  ): Layer.Layer<Engine, never, FileSystem | ServicesOf<R>> =>
    Layer.effect(
      Engine,
      Effect.gen(function* () {
        const { registry, appVersion } = options
        const services = yield* Effect.context<ServicesOf<R>>()
        const start: StartRun = (block, props, input) => {
          // The block is one of `registry`'s, so what it asks for is in `ServicesOf<R>`.
          const run: Stream.Stream<TaskEvent<string>, TaskError, ServicesOf<R>> = block.run(
            props,
            input,
          )
          return Stream.provideContext(run, services)
        }
        const readForm: ReadForm = (fields, props) => {
          // As for `start`: the block is one of `registry`'s.
          const read: Effect.Effect<FormSpec, PropError, ServicesOf<R>> = fields(props, new Map())
          return Effect.provideContext(read, services)
        }
        const fileSystem = yield* Effect.context<FileSystem>()
        const sessions = new Map<SessionId, Session>()

        const lookup = (session: SessionId): Effect.Effect<Session, UnknownSession> => {
          const found = sessions.get(session)
          return found === undefined
            ? Effect.fail(new UnknownSession({ session }))
            : Effect.succeed(found)
        }

        yield* Effect.addFinalizer(() =>
          Effect.forEach(Array.from(sessions.values()), (session) => session.close, {
            discard: true,
          }),
        )

        return Engine.of({
          openSession: Effect.fn("Engine.openSession")(function* ({ path: file }) {
            const result = yield* loadRunbook(file, registry, { appVersion }).pipe(
              Effect.provideContext(fileSystem),
              Effect.catchTags({
                FileNotFoundError: () => unreadable(file, `There is no file at ${file}.`),
                FileReadError: ({ cause }) =>
                  unreadable(
                    file,
                    `${file} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
                  ),
              }),
            )
            if (result._tag === "Invalid")
              return { _tag: "Invalid", errors: result.errors, warnings: result.warnings } as const
            const session = yield* makeSession({
              id: decodeSessionId(crypto.randomUUID()),
              document: result.document,
              registry,
              start,
              readForm,
            })
            sessions.set(session.id, session)
            return { _tag: "Opened", session: session.view() } as const
          }),

          closeSession: Effect.fn("Engine.closeSession")(function* ({ session }) {
            const found = yield* lookup(session)
            sessions.delete(session)
            yield* found.close
          }),

          listSessions: Effect.sync(() => Array.from(sessions.values(), (s) => s.summary())),

          getSession: Effect.fn("Engine.getSession")(function* ({ session }) {
            return (yield* lookup(session)).view()
          }),

          trustSession: Effect.fn("Engine.trustSession")(function* ({ session, hash }) {
            const { origin } = yield* Caller
            if (origin !== "person")
              return yield* new Forbidden({ command: "TrustSession", origin })
            return yield* (yield* lookup(session)).trust(hash)
          }),

          events: ({ session, after }) =>
            Stream.unwrap(Effect.map(lookup(session), (found) => found.events(after))),

          getBlock: Effect.fn("Engine.getBlock")(function* ({
            session,
            block,
            logOffset,
            logLimit,
          }) {
            return yield* (yield* lookup(session)).getBlock(block, logOffset, logLimit)
          }),

          setValues: Effect.fn("Engine.setValues")(function* ({ session, block, values }) {
            const { origin } = yield* Caller
            return yield* (yield* lookup(session)).setValues(block, values, origin)
          }),

          confirmValues: Effect.fn("Engine.confirmValues")(function* ({ session, block }) {
            const { origin } = yield* Caller
            return yield* (yield* lookup(session)).confirmValues(block, origin)
          }),

          runBlock: Effect.fn("Engine.runBlock")(function* ({ session, block }) {
            const { origin } = yield* Caller
            return yield* (yield* lookup(session)).runBlock(block, origin)
          }),

          cancelBlock: Effect.fn("Engine.cancelBlock")(function* ({ session, block }) {
            return yield* (yield* lookup(session)).cancelBlock(block)
          }),

          resetBlock: Effect.fn("Engine.resetBlock")(function* ({ session, block }) {
            return yield* (yield* lookup(session)).resetBlock(block)
          }),

          waitForBlock: Effect.fn("Engine.waitForBlock")(function* (payload) {
            const found = yield* lookup(payload.session)
            return yield* found.waitForBlock(
              payload.block,
              payload.timeoutMillis ?? LIMITS.defaultWaitMillis,
              payload.logOffset,
              payload.logLimit,
            )
          }),

          getOutputs: Effect.fn("Engine.getOutputs")(function* ({ session }) {
            return (yield* lookup(session)).outputs()
          }),
        })
      }),
    )
}
