/**
 * The engine: owns every open session and serves the protocol's session
 * and block commands. It is headless; the app window, the CLI and MCP reach
 * it through a transport. The registry is passed in, so the core never
 * imports the blocks.
 */
import path from "node:path"
import { Clock, Context, Effect, Layer, Option, Schema, Scope, Stream } from "effect"
import type { Rpc } from "effect/rpc"
import {
  type RunbookPath,
  type TaskError,
  type TaskEvent,
  TaskTimedOut,
} from "@runbooks/blocks-core/contract"
import type { Registry, ServicesOf } from "@runbooks/blocks-core/registry"
import { CredentialProviders } from "../credential/provider.ts"
import { prepareStateDir } from "../credential/stateDir.ts"
import { type FileFact, readRunbookFile } from "../document/files.ts"
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
  type GetScriptFiles,
  type GetDocument,
  type GetOutputs,
  type GetSession,
  LIMITS,
  type ConfirmValues,
  type ListSessions,
  type OpenSession,
  type ReloadFiles,
  type ResetBlock,
  type ResolveApproval,
  type RunBlock,
  RunbookUnreadable,
  SessionId,
  type SetValues,
  type TrustSession,
  UnknownApproval,
  UnknownSequence,
  UnknownSession,
  type WaitForBlock,
  type WatchMode,
} from "./protocol.ts"
import { baseEnvironment, providerEnvironment } from "./env.ts"
import { resolvePaths, sessionRoots } from "./roots.ts"
import { copyGenerated, makeRunFiles, readRunFiles } from "./runFiles.ts"
import {
  makeSession,
  type ParsedRunbook,
  type ReloadFilesFrom,
  type Runner,
  type RunbookReload,
  type Session,
} from "./session.ts"
import { resumeOf, type SavedSession, SessionStore } from "./sessionStore.ts"
import { SettingsStore } from "./settings.ts"
import { watchSession } from "./watcher.ts"

/** Serves one protocol command, with the command's own payload, success and error types. */
type Command<R extends Rpc.Any, Requires = never> = (
  payload: Rpc.Payload<R>,
) => Effect.Effect<Rpc.Success<R>, Rpc.Error<R>, Requires>

export interface EngineShape {
  /**
   * Resumes the runbook's most recently used saved session, unless it is
   * open already (open decision 18: one window); otherwise starts one.
   */
  readonly openSession: Command<typeof OpenSession, Caller>
  /** Interrupts the session's runs and ends its event streams. */
  readonly closeSession: Command<typeof CloseSession>
  readonly listSessions: Effect.Effect<Rpc.Success<typeof ListSessions>>
  readonly getSession: Command<typeof GetSession>
  /** The document the session holds, with the errors the engine found in it. */
  readonly getDocument: Command<typeof GetDocument>
  /** Person only. */
  readonly trustSession: Command<typeof TrustSession, Caller>
  readonly events: (
    payload: Rpc.Payload<typeof Events>,
  ) => Stream.Stream<EventEnvelope, UnknownSession | UnknownSequence>
  readonly getBlock: Command<typeof GetBlock>
  /** A person's and an agent's alike, as `getBlock`. */
  readonly getScriptFiles: Command<typeof GetScriptFiles>
  /** Enters values as if typed. An agent's are reviewed; a value a person changes is not. */
  readonly setValues: Command<typeof SetValues, Caller>
  /** An agent's counts every field the form shows as reviewed, defaults included; a person's changes nothing. */
  readonly confirmValues: Command<typeof ConfirmValues, Caller>
  /** Runs a task or submits a form. An agent's is refused until every field it reads is reviewed. */
  readonly runBlock: Command<typeof RunBlock, Caller>
  readonly cancelBlock: Command<typeof CancelBlock>
  readonly resetBlock: Command<typeof ResetBlock>
  /** Person only: a reload keeps the session's trust. */
  readonly reloadFiles: Command<typeof ReloadFiles, Caller>
  readonly waitForBlock: Command<typeof WaitForBlock>
  readonly getOutputs: Command<typeof GetOutputs>
  /** Confirm a detected login, sign in, choose a target, sign out. Refused in a state that does not take it. */
  readonly actOnCredential: Command<typeof ActOnCredential>
  /** Person only. */
  readonly resolveApproval: Command<typeof ResolveApproval, Caller>
  /**
   * Not a protocol command, and no client reaches it (`serveEngine`): what
   * a session's watcher does once its runbook is saved, in a watch mode the
   * person chose at open. Reads the runbook and the files its blocks name
   * from disk again, and reloads the session with them (`Session.reload`),
   * each file at the text the session holds when `from` is `held`.
   */
  readonly reloadRunbook: (
    session: SessionId,
    from: ReloadFilesFrom,
  ) => Effect.Effect<RunbookReload, UnknownSession>
  /**
   * Not a protocol command, and no client reaches it (`serveEngine`): what
   * a session's watcher does when files its runbook names change on disk.
   * Reads each of `paths` from the runbook's folder, once, and gives the
   * session what it read (`Session.filesChanged`).
   */
  readonly filesChanged: (
    session: SessionId,
    paths: ReadonlyArray<RunbookPath>,
  ) => Effect.Effect<void, UnknownSession>
}

export interface EngineOptions<R extends Registry> {
  readonly registry: R
  /** Checked against a runbook's `runbooks:` requirement. */
  readonly appVersion: string
  /**
   * The folder that holds each session's working folder, named by the
   * session's id: the app's `<userData>/v0/sessions/dirs`. Only the entry
   * point sets it; no protocol command names a root. A session retention
   * drops goes with its folder.
   */
  readonly workingFolders: string
  /**
   * The folder that holds each session's credential provider state, by
   * session id and then block id: the app's `<userData>/v0/sessions/state`.
   * Only the entry point sets it. A session retention drops goes with its
   * folder.
   */
  readonly stateFolders: string
  /**
   * The app's process environment, read at the entry point. Every run's
   * environment starts from it, less the names every credential block in
   * the registry declares and the reserved ones.
   */
  readonly processEnvironment: Readonly<Record<string, string>>
  /**
   * Whether a task's own time limit (`TaskBlock.timeLimit`) applies.
   * `runbooks test` sets `"ignore"`: its `timeout` setting limits every step
   * instead, as today's test runner does. Absent: `"apply"`.
   */
  readonly blockTimeLimits?: "apply" | "ignore"
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
   * Before it serves anything, it drops the sessions retention names, so
   * none of them is open: each one's working and state folders first, then
   * what it saved. A session whose folders cannot be deleted is kept, and
   * retention names it again at the next start.
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
        const files = yield* FileSystem
        for (const expired of yield* store.expired) {
          const deleted = yield* Effect.forEach(
            [path.join(workingFolders, expired), path.join(stateFolders, expired)],
            (folder) => files.rm(folder, { recursive: true, force: true }),
            { discard: true },
          ).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.as(
                Effect.logWarning(
                  `Session ${expired} was kept: its folder ${error.path} could not be deleted: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
                ),
                false,
              ),
            ),
          )
          if (deleted) yield* store.forget(expired)
        }
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
            const limit =
              options.blockTimeLimits === "ignore" ? undefined : block.timeLimit?.(props)
            const limited =
              limit === undefined
                ? run
                : Stream.interruptWhen(
                    run,
                    Effect.andThen(
                      Effect.sleep(limit),
                      Effect.fail(new TaskTimedOut({ afterMillis: limit })),
                    ),
                  )
            return Stream.provideContext(limited, Context.add(services, Scope.Scope, scope))
          },
          resolve: (at, named, repository) =>
            resolvePaths(at, named, repository).pipe(Effect.provideContext(fileSystem)),
          makeRunFiles: Effect.provideContext(makeRunFiles, fileSystem),
          readRunFiles: (written) => Effect.provideContext(readRunFiles(written), fileSystem),
          copyGenerated: (from, to) => Effect.provideContext(copyGenerated(from, to), fileSystem),
          // The block's state folder is made owner-only before its provider starts.
          openProvider: (provider, config) =>
            Effect.andThen(
              Effect.provideContext(prepareStateDir(config.stateDir), fileSystem),
              providers.open(provider, config),
            ),
        }
        const sessions = new Map<SessionId, Session>()
        /** Saved sessions an open is resuming now, so a second open at once starts a new one. */
        const resuming = new Set<SessionId>()

        const lookup = (session: SessionId): Effect.Effect<Session, UnknownSession> => {
          const found = sessions.get(session)
          return found === undefined
            ? Effect.fail(new UnknownSession({ session }))
            : Effect.succeed(found)
        }

        /** The runbook at `file`, which is absolute, and the files its blocks name, read from disk now. */
        const load = (file: string) =>
          loadRunbook(file, registry, { appVersion }).pipe(
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

        /** Reads the session's runbook from disk, and reloads the session with it. */
        const reloadOf = (session: Session, from: ReloadFilesFrom) =>
          Effect.flatMap(
            load(session.summary().path).pipe(
              Effect.catchTag("RunbookUnreadable", ({ message }) =>
                Effect.succeed({ _tag: "Unreadable", message } as const),
              ),
            ),
            (read) => session.reload(read, from),
          )

        /** Reads `paths` from disk, and gives the session what it read. */
        const filesChangedOf = Effect.fnUntraced(function* (
          session: Session,
          paths: ReadonlyArray<RunbookPath>,
        ) {
          const folder = path.dirname(session.summary().path)
          const facts = new Map<RunbookPath, FileFact>()
          for (const named of paths)
            facts.set(
              named,
              yield* readRunbookFile(folder, named).pipe(Effect.provideContext(fileSystem)),
            )
          yield* session.filesChanged(facts)
        })

        /** What a session opened in `mode` runs to watch its runbook, if anything. */
        const watcherOf = (file: string, mode: WatchMode) =>
          mode === "off"
            ? {}
            : {
                watch: (session: Session, held: () => ReadonlyMap<RunbookPath, FileFact>) =>
                  watchSession(mode, {
                    runbook: file,
                    files: held,
                    sequence: () => session.view().sequence,
                    events: session.events,
                    filesChanged: (paths) => filesChangedOf(session, paths),
                    reload: (from) => reloadOf(session, from),
                    unwatched: session.unwatched,
                  }).pipe(Effect.provideContext(fileSystem)),
              }

        /** Opens a session of the loaded runbook as `id`, resuming `saved` when there is one. */
        const opened = Effect.fnUntraced(function* (
          file: string,
          loaded: ParsedRunbook,
          saved: Option.Option<SavedSession>,
          id: SessionId,
          watch: WatchMode,
        ) {
          const { document } = loaded
          const firstSequence = Option.match(saved, {
            onNone: () => 0,
            onSome: (found) => found.nextSequence,
          })
          const saver = yield* store.keep({
            id,
            runbook: file,
            runbookHash: document.hash.runbook,
            createdAt: yield* Option.match(saved, {
              onNone: () => Clock.currentTimeMillis,
              onSome: (found) => Effect.succeed(found.createdAt),
            }),
            firstSequence,
          })
          // A resumed session keeps its id, and with it its working and state folders.
          const session = yield* makeSession({
            id,
            runbook: loaded,
            appVersion,
            roots: sessionRoots(file, workingFolders, id),
            baseEnvironment: base,
            registry,
            stateFolder: path.join(stateFolders, id),
            providerEnvironment: (envNames) =>
              providerEnvironment(base, options.processEnvironment, envNames),
            network,
            resume: Option.map(saved, (found) => resumeOf(document, registry, found)),
            saver,
            firstSequence,
            // For the session's lifetime. Opening its runbook again opens another
            // session, in its own mode, and changes nothing of this one's.
            ...watcherOf(file, watch),
          })
          sessions.set(session.id, session)
          // Trust comes back only for the content it was given for: `trust` refuses another hash.
          const trusted = Option.flatMap(saved, (found) => found.trusted)
          if (Option.isSome(trusted)) yield* session.trust(trusted.value, runner)
          return { _tag: "Opened", session: session.view() } as const
        })

        // Every session at once, so each one's running scripts are stopped together.
        yield* Effect.addFinalizer(() =>
          Effect.forEach(Array.from(sessions.values()), (session) => session.close, {
            concurrency: "unbounded",
            discard: true,
          }),
        )

        return Engine.of({
          openSession: Effect.fn("Engine.openSession")(function* ({ path: file, watch }) {
            const { origin } = yield* Caller
            // A reload keeps the session's trust, so only a person chooses a mode that reloads.
            if (origin !== "person" && (watch === "runbook" || watch === "runbookAndFiles"))
              return yield* new Forbidden({ command: "OpenSession", origin })
            // A transport decodes the payload; an in-process caller may not.
            if (!isAbsolute(file))
              return yield* unreadable(file, `${file} is not an absolute path.`)
            const result = yield* load(file)
            if (result._tag === "Invalid")
              return { _tag: "Invalid", errors: result.errors, warnings: result.warnings } as const
            // Taken in the step that checks it: two opens of one runbook at once
            // would otherwise both resume it, as two sessions with one id.
            const saved = Option.filter(
              yield* store.latest(file),
              (found) => !sessions.has(found.id) && !resuming.has(found.id),
            )
            if (Option.isSome(saved)) resuming.add(saved.value.id)
            const id = Option.match(saved, {
              onNone: () => decodeSessionId(crypto.randomUUID()),
              onSome: (found) => found.id,
            })
            return yield* Effect.ensuring(
              opened(file, result, saved, id, watch ?? "off"),
              Effect.sync(() => resuming.delete(id)),
            )
          }),

          closeSession: Effect.fn("Engine.closeSession")(function* ({ session }) {
            const found = yield* lookup(session)
            // Forgotten once its close begins, however this call ends. One cancelled
            // before it began leaves the session open, to be closed again.
            yield* Effect.ensuring(
              found.close,
              Effect.sync(() => {
                if (found.closing()) sessions.delete(session)
              }),
            )
          }),

          listSessions: Effect.sync(() => Array.from(sessions.values(), (s) => s.summary())),

          getSession: Effect.fn("Engine.getSession")(function* ({ session }) {
            return (yield* lookup(session)).view()
          }),

          getDocument: Effect.fn("Engine.getDocument")(function* ({ session }) {
            return (yield* lookup(session)).documentView()
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

          getScriptFiles: Effect.fn("Engine.getScriptFiles")(function* ({ session, block }) {
            return yield* (yield* lookup(session)).getScriptFiles(block)
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

          reloadFiles: Effect.fn("Engine.reloadFiles")(function* ({ session, block, hash }) {
            const { origin } = yield* Caller
            if (origin !== "person") return yield* new Forbidden({ command: "ReloadFiles", origin })
            return yield* (yield* lookup(session)).reloadFiles(block, hash)
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

          resolveApproval: Effect.fn("Engine.resolveApproval")(function* ({ session, approval }) {
            const { origin } = yield* Caller
            if (origin !== "person")
              return yield* new Forbidden({ command: "ResolveApproval", origin })
            yield* lookup(session)
            // No session asks for an approval until the agent's run
            // confirmation (step 3, item 7), so none is pending to resolve.
            return yield* new UnknownApproval({ approval })
          }),

          reloadRunbook: Effect.fn("Engine.reloadRunbook")(function* (session, from) {
            return yield* reloadOf(yield* lookup(session), from)
          }),

          filesChanged: Effect.fn("Engine.filesChanged")(function* (session, paths) {
            yield* filesChangedOf(yield* lookup(session), paths)
          }),
        })
      }),
    )
}
