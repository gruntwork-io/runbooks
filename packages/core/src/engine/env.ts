/**
 * A run's environment, built per run from what its block names (ruled
 * 2026-11-23): the base environment, then each `envFrom` source in the
 * order written, then the block's own `env`, a later layer winning. No
 * layer sets a name Runbooks sets for every run. Nothing else reaches a
 * run: not another block's environment, not what an earlier run exported,
 * not what a source got from its own sources.
 *
 * Every value is `Redacted` from the moment it enters until the block hands
 * the environment to its process. A message here names variables, never
 * their values.
 */
import { Effect, Redacted } from "effect"
import {
  type BlockId,
  type CredentialError,
  type RunEnv,
  TaskFailed,
} from "@runbooks/blocks-core/contract"
import { isAlias, type Registry } from "@runbooks/blocks-core/registry"
import type { CredentialEnv } from "../credential/provider.ts"
import { isReservedEnvName } from "../document/document.ts"

/** The app's process environment less every credential block's names and every reserved name. */
export type BaseEnvironment = ReadonlyMap<string, Redacted.Redacted<string>>

/**
 * The base environment: the app's process environment, read at the entry
 * point, with the names every credential block in `registry` declares
 * removed (ambient credentials do not load, ruled 2026-11-23), and the
 * reserved names, which a process started from a run would otherwise carry.
 */
export function baseEnvironment(
  processEnvironment: Readonly<Record<string, string>>,
  registry: Registry,
): BaseEnvironment {
  const credentialNames = new Set(
    Object.values(registry).flatMap((entry) =>
      !isAlias(entry) && entry.class === "credential" ? entry.envNames : [],
    ),
  )
  return new Map(
    Object.entries(processEnvironment).flatMap(([name, value]) =>
      credentialNames.has(name) || isReservedEnvName(name) ? [] : [[name, Redacted.make(value)]],
    ),
  )
}

/** What one source gives a run: variables to set, and variables it declares but did not return, to unset. */
export interface Contribution {
  readonly set: ReadonlyMap<string, Redacted.Redacted<string>>
  readonly unset: ReadonlySet<string>
}

/** One `envFrom` source, as a run reads it when it starts. */
export interface EnvSource {
  readonly block: BlockId
  readonly contribution: Effect.Effect<Contribution, TaskFailed>
}

/** A done task: what it exported, as its run left it. */
export const taskSource = (
  block: BlockId,
  exported: ReadonlyMap<string, Redacted.Redacted<string>>,
): EnvSource => ({ block, contribution: Effect.succeed({ set: exported, unset: new Set() }) })

/** What a Ready credential block gives a run: its provider's `env`, read as the run starts (`./credentials.ts`). */
export interface CredentialHandle {
  /** The provider refreshes first if it can. */
  readonly env: Effect.Effect<CredentialEnv, CredentialError>
}

/**
 * A credential block, through its handle. It gives only the names the block
 * declares (`envNames`), and unsets those its provider did not return, so
 * a variable from an earlier source cannot pair with this one's. A run it
 * gives any other name fails before it starts.
 */
export const credentialSource = (
  block: BlockId,
  envNames: ReadonlyArray<string>,
  handle: CredentialHandle,
): EnvSource => ({
  block,
  contribution: handle.env.pipe(
    Effect.mapError(
      (error) =>
        new TaskFailed({
          message: `${block} could not give the run its credentials: ${error.message}`,
        }),
    ),
    Effect.flatMap(({ values }) => {
      const declared = new Set(envNames)
      const given = values.filter((value) => value.to.includes("env"))
      const refused = given.filter(({ name }) => !declared.has(name)).map(({ name }) => name)
      if (refused.length > 0)
        return Effect.fail(
          new TaskFailed({
            message: `${block} gave ${[...new Set(refused)].sort().join(", ")}, which it does not declare, so the run did not start.`,
          }),
        )
      const set = new Map(given.map(({ name, value }) => [name, value]))
      return Effect.succeed({ set, unset: new Set(envNames.filter((name) => !set.has(name))) })
    }),
  ),
})

/** A variable two `envFrom` sources set: the later one's value is the run's. */
export interface EnvConflict {
  readonly name: string
  readonly earlier: BlockId
  readonly later: BlockId
}

/** The layers of one run's environment, earliest first. */
export interface RunEnvLayers {
  readonly base: BaseEnvironment
  readonly sources: ReadonlyArray<EnvSource>
  /** The block's own `env` prop, which holds no reserved name. */
  readonly own: Readonly<Record<string, string>>
}

/**
 * `env` with the names Runbooks sets for the run, such as `RUNBOOK_ENV`,
 * set over every layer. No layer can set one in the first place: the base
 * and each source drop them, and the parser refuses one in `env`.
 */
export const withReserved = (env: RunEnv, reserved: Readonly<Record<string, string>>): RunEnv => ({
  ...env,
  ...Object.fromEntries(
    Object.entries(reserved).map(([name, value]) => [name, Redacted.make(value)]),
  ),
})

/** Builds a run's environment from its layers, and says which variables two sources both set. */
export const buildRunEnv = Effect.fnUntraced(function* ({ base, sources, own }: RunEnvLayers) {
  const env = new Map(base)
  /** The source that set each variable a source set. */
  const setBy = new Map<string, BlockId>()
  const conflicts: EnvConflict[] = []
  for (const source of sources) {
    const { set, unset } = yield* source.contribution
    for (const name of unset) {
      env.delete(name)
      setBy.delete(name)
    }
    for (const [name, value] of set) {
      if (isReservedEnvName(name)) continue
      const earlier = setBy.get(name)
      if (earlier !== undefined && earlier !== source.block)
        conflicts.push({ name, earlier, later: source.block })
      env.set(name, value)
      setBy.set(name, source.block)
    }
  }
  // The parser refused a reserved name in `env`; a source's names come from a run or a provider.
  for (const [name, value] of Object.entries(own)) env.set(name, Redacted.make(value))
  const built: RunEnv = Object.fromEntries(env)
  return { env: built, conflicts }
})
