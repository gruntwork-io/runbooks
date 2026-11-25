/**
 * For the tests of the roots the engine sets, in the core and against the
 * real filesystem: two toy tasks, and a trusted session to run them in.
 * `Touch` names one path, in the root its props say. `Clone` makes a
 * repository where its `localPath` field says, as GitClone does. Each notes
 * its latest run's input, by its `label` prop.
 */
import path from "node:path"
import { Effect, type Layer, Schema, Stream } from "effect"
import { BlockId, defineTask, Root, type TaskInput } from "@runbooks/blocks-core/contract"
import type { FieldValue } from "@runbooks/blocks-core/form"
import { Engine } from "../engine/engine.ts"
import { Caller, type SessionId } from "../engine/protocol.ts"
import type { FileSystem } from "../services/FileSystem.ts"
import { testCredentialProviders } from "./TestCredentialProviders.ts"
import { TOY_REGISTRY, toyFormSpec } from "./toyRegistry.ts"

const blockId = Schema.decodeSync(BlockId)

/** The input of each block's latest run, by its label. */
type Seen = Map<string, TaskInput<string>>

const rootsRegistry = (seen: Seen) => {
  const note = (label: string) => (input: TaskInput<string>) =>
    Stream.fromEffectDrain(Effect.sync(() => seen.set(label, input)))
  return {
    ...TOY_REGISTRY,
    Touch: defineTask({
      name: "Touch",
      since: "0.1.0",
      class: "task",
      props: Schema.Struct({
        label: Schema.String,
        root: Root,
        path: Schema.String,
        repository: Schema.optionalKey(BlockId),
      }),
      children: { kind: "none" },
      references: { repository: "repository" },
      runbookFiles: () => [],
      provides: ["run"],
      effects: ["files"],
      outputs: () => ({}),
      paths: (p) => ({ target: { root: p.root, path: p.path } }),
      run: (p, input) => note(p.label)(input),
      instruction: () => [],
      plugins: [],
    }),
    Clone: defineTask({
      name: "Clone",
      since: "0.1.0",
      class: "task",
      props: Schema.Struct({ label: Schema.String, localPath: Schema.optionalKey(Schema.String) }),
      children: { kind: "none" },
      references: {},
      runbookFiles: () => [],
      provides: ["run", "repository"],
      effects: ["repository", "network"],
      outputs: () => ({}),
      fields: (p) =>
        Effect.succeed(
          toyFormSpec([{ name: "localPath", type: "string", default: p.localPath ?? "repo" }]),
        ),
      paths: (_p, values) => {
        const localPath = values["localPath"]
        return { target: { root: "working", path: typeof localPath === "string" ? localPath : "" } }
      },
      repository: "target",
      run: (p, input) => note(p.label)(input),
      instruction: () => [],
      plugins: [],
    }),
  }
}

const commandsFor = (engine: Engine["Service"], session: SessionId) => {
  const target = (block: string) => ({ session, block: blockId(block) })
  return {
    set: (block: string, values: Readonly<Record<string, FieldValue>>) =>
      engine.setValues({ ...target(block), values }),
    /** The block's status once its run ends. */
    run: (block: string) =>
      Effect.gen(function* () {
        yield* engine.runBlock(target(block))
        const done = yield* engine.waitForBlock({ ...target(block), timeoutMillis: 5000 })
        return done.block.status
      }),
  }
}

export type RootsSession = ReturnType<typeof commandsFor> & {
  /** The session's working folder, as the engine should set it. */
  readonly working: string
  readonly seen: Seen
}

/** What a test does with its session. */
export type UseRootsSession<A, E> = (rb: RootsSession) => Effect.Effect<A, E, Engine | Caller>

/** Opens the runbook at `file`, trusts it, and gives `use` its commands. */
export const withRootsSession = <A, E>(
  setup: {
    readonly file: string
    readonly workingFolders: string
    readonly fileSystem: Layer.Layer<FileSystem>
  },
  use: UseRootsSession<A, E>,
): Promise<A> => {
  const seen: Seen = new Map()
  return Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* Engine
      const opened = yield* engine.openSession({ path: setup.file })
      if (opened._tag !== "Opened") throw new Error(opened.errors.map((e) => e.message).join())
      const { session, trust } = opened.session
      yield* engine.trustSession({ session, hash: trust.hash })
      return yield* use({
        ...commandsFor(engine, session),
        working: path.join(setup.workingFolders, session),
        seen,
      })
    }).pipe(
      Effect.provide(
        Engine.layer({
          registry: rootsRegistry(seen),
          appVersion: "0.31.0",
          workingFolders: setup.workingFolders,
          stateFolders: "/state",
          processEnvironment: {},
        }),
      ),
      Effect.provide(testCredentialProviders({}, [])),
      Effect.provide(setup.fileSystem),
      Effect.provideService(Caller, { origin: "person" }),
    ),
  )
}
