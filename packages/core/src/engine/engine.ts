/**
 * The engine: owns every open session and serves the protocol's session
 * and block commands. It is headless; the app window, the CLI and MCP reach
 * it through a transport. The registry is passed in, so the core never
 * imports the blocks.
 */
import path from "node:path"
import { Clock, Context, Effect, Layer, Option, Schema, Scope, Stream } from "effect"
import type { Rpc } from "effect/rpc"
import type { TaskError, TaskEvent } from "@runbooks/blocks-core/contract"
import type { Registry, ServicesOf } from "@runbooks/blocks-core/registry"
import { CredentialProviders } from "../credential/provider.ts"
import { loadRunbook } from "../document/load.ts"
import { FileSystem } from "../services/FileSystem.ts"
import {
  AbsolutePath,
  type ActOnCredential,
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
import { baseEnvironment } from "./env.ts"
import { resolvePaths, sessionRoots } from "./roots.ts"
import { makeRunFiles, readRunFiles } from "./runFiles.ts"
import { makeSession, type Runner, type Session } from "./session.ts"
import { resumeOf, SessionStore } from "./sessionStore.ts"
import { SettingsStore } from "./settings.ts"

/** Serves one protocol command, with the command's own payload, success and error types. */
type Command<R extends Rpc.Any, Requires = never> = (
  payload: Rpc.Payload<R>,
) => Effect.Effect<Rpc.Success<R>, Rpc.Error<R>, Requires>

export interface EngineShape {
  /**
   * Resumes the runbook's most recently used saved session, unless it is
   * open already (open decision 18: one window); otherwise starts one.
   */
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
  /** Confirm a detected login, sign in, choose a target, sign out. Refused in a state that does not take it. */
  readonly actOnCredential: Command<typeof ActOnCredential>
}

export interface EngineOptions<R extends Registry> {
  readonly registry: R
  /** Checked against a runbook's `runbooks:` requirement. */
  readonly appVersion: string
  /**
   * The folder that holds each session's working folder, named by the
   * session's id: the app's `<userData>/v0/sessions/dirs`. Only the entry
   * point sets it; no protocol command names a root.
   */
  readonly workingFolders: string
  /**
   * The folder that holds each session's credential provider state, by
   * session id and then block id: the app's `<userData>/v0/sessions/state`.
   * Only the entry point sets it.
   */
  readonly stateFolders: string
  /**
   * The app's process environment, read at the entry point. Every run's
   * environment starts from it, less the names every credential block in
   * the registry declares and the reserved ones.
   */
  readonly processEnvironment: Readonly<Record<string, string>>
}

const decodeSessionId = Schema.decodeSync(SessionId)
const isAbsolutePath = Schema.is(AbsolutePath)
/** Not a type guard: the payload is typed as a string whether or not a transport decoded it. */
const isAbsolute = (file: string): boolean => isAbsolutePath(file)

const unreadable = (file: string, message: string) =>
  Effect.fail(new RunbookUnreadable({ path: file, message }))

export class Engine extends Context.Service<Engine, EngineShape>()("@runbooks/core/engine/Engine") {
  /**
   * The engine for `registry`. It needs the services every block in the
   * registry asks for, and gives them to each run: a session can start a run
   * only once the person trusts it. Before that, the engine reads the runbook
   * and the files its blocks name, and nothing else: it opens no credential
   * provider. A provider opens with the CA bundle and proxy the settings
   * hold when it opens. Closing the layer closes every session.
   *
   * Each session saves what it holds through the `SessionStore`, and the
   * engine resumes it when the runbook is opened again (`openSession`).
   */
  static readonly layer = <R extends Registry>(
    options: EngineOptions<R>,
  ): Layer.Layer<
    Engine,
    never,
    | FileSystem
    | CredentialProviders
    | SettingsStore
    | SessionStore
    | Exclude<ServicesOf<R>, Scope.Scope>
  > =>
    Layer.effect(
      Engine,
      Effect.gen(function* () {
        const { registry, appVersion, workingFolders, stateFolders } = options
        const providers = yield* CredentialProviders
        const settings = yield* SettingsStore
        const store = yield* SessionStore
        const network = Effect.map(settings.get, ({ settings: { caBundleFile, proxy } }) => ({
          caBundleFile: Option.fromNullOr(caBundleFile),
          proxy: Option.fromNullOr(proxy),
        }))
        const base = baseEnvironment(options.processEnvironment, registry)
        // The layer's context holds the layer's own scope too. A resource held
        // there would outlast its run, so a run gets a scope of its own in its
        // place, and the run files get the FileSystem alone.
        const services = yield* Effect.context<ServicesOf<R>>()
        const fileSystem = Context.pick(FileSystem)(yield* Effect.context<FileSystem>())
        /** Handed to a session when the person trusts it, and not before. */
        const runner: Runner = {
          start: (block, props, input, scope) => {
            // The block is one of `registry`'s, so what it asks for is in `ServicesOf<R>`.
            const run: Stream.Stream<TaskEvent<string>, TaskError, ServicesOf<R>> = block.run(
              props,
              input,
            )
            return Stream.provideContext(run, Context.add(services, Scope.Scope, scope))
          },
          resolve: (at, named, repository) =>
            resolvePaths(at, named, repository).pipe(Effect.provideContext(fileSystem)),
          makeRunFiles: Effect.provideContext(makeRunFiles, fileSystem),
          readRunFiles: (written) => Effect.provideContext(readRunFiles(written), fileSystem),
          openProvider: providers.open,
        }
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
            // A transport decodes the payload; an in-process caller may not.
            if (!isAbsolute(file))
              return yield* unreadable(file, `${file} is not an absolute path.`)
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
            const { document } = result
            const saved = Option.filter(
              yield* store.latest(file),
              (found) => !sessions.has(found.id),
            )
            const id = Option.match(saved, {
              onNone: () => decodeSessionId(crypto.randomUUID()),
              onSome: (found) => found.id,
            })
            const saver = yield* store.keep({
              id,
              runbook: file,
              runbookHash: document.hash.runbook,
              createdAt: yield* Option.match(saved, {
                onNone: () => Clock.currentTimeMillis,
                onSome: (found) => Effect.succeed(found.createdAt),
              }),
            })
            // A resumed session keeps its id, and with it its working and state folders.
            const session = yield* makeSession({
              id,
              document,
              texts: result.texts,
              roots: sessionRoots(file, workingFolders, id),
              baseEnvironment: base,
              registry,
              stateFolder: path.join(stateFolders, id),
              network,
              resume: Option.map(saved, (found) => resumeOf(document, registry, found)),
              saver,
            })
            sessions.set(session.id, session)
            // Trust comes back only for the content it was given for: `trust` refuses another hash.
            const trusted = Option.flatMap(saved, (found) => found.trusted)
            if (Option.isSome(trusted)) yield* session.trust(trusted.value, runner)
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
            return yield* (yield* lookup(session)).trust(hash, runner)
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

          actOnCredential: Effect.fn("Engine.actOnCredential")(function* ({
            session,
            block,
            action,
          }) {
            return yield* (yield* lookup(session)).actOnCredential(block, action)
          }),
        })
      }),
    )
}
