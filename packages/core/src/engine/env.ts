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
import { Effect, Redacted, Result } from "effect"
import {
  type BlockId,
  type CredentialError,
  type RunEnv,
  TaskFailed,
} from "@runbooks/blocks-core/contract"
import { isAlias, type Registry } from "@runbooks/blocks-core/registry"
import type { CredentialEnv } from "../credential/provider.ts"
import { isReservedEnvName } from "../document/document.ts"
import { renderValueTemplate, type ValueSources } from "../document/valueTemplate.ts"

/** What a process can be started with, on every system Runbooks runs on. */
export const RUN_ENV_LIMITS = {
  /**
   * Bytes in one variable, as `NAME=value` in UTF-8 and its NUL. Linux's
   * execve refuses a longer string: MAX_ARG_STRLEN, 32 pages of 4 KiB.
   */
  variableBytes: 128 * 1024,
  /**
   * Bytes in the whole environment, each variable counted as its
   * `variableBytes` and its pointer. macOS's execve takes 1 MiB
   * (kern.argmax) for the arguments, the environment and their pointers
   * together; Linux a quarter of the stack limit, 2 MiB at the usual
   * 8 MiB. 64 KiB of macOS's is left for what the run adds after: the
   * interpreter and script path it runs, and the variables Runbooks sets
   * (its run files and log files), under 50 KiB with paths of 4096 bytes.
   */
  totalBytes: 1024 * 1024 - 64 * 1024,
} as const

/** What a variable's pointer in the environment takes on a 64-bit system. */
const POINTER_BYTES = 8

const encoder = new TextEncoder()

/** The bytes `text` takes in UTF-8, as a process is given it. */
export const utf8Bytes = (text: string): number => encoder.encode(text).length

/** The bytes a variable takes in a process's environment: `NAME=value` in UTF-8, and its NUL. */
export const variableBytes = (name: string, value: string): number =>
  utf8Bytes(name) + 1 + utf8Bytes(value) + 1

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

/**
 * What a credential block's provider runs with: the base environment, and
 * the names the block itself declares (`envNames`) taken back from the
 * app's process environment, so an `env` detection source finds a login
 * there. Another credential block's names stay out, as do the reserved
 * ones. A tool the provider runs (`az`) reads its own config files through
 * the host variables the base environment keeps: HOME, PATH and the like.
 */
export function providerEnvironment(
  base: BaseEnvironment,
  processEnvironment: Readonly<Record<string, string>>,
  envNames: ReadonlyArray<string>,
): BaseEnvironment {
  const own = envNames.flatMap((name) => {
    const value = Object.hasOwn(processEnvironment, name) ? processEnvironment[name] : undefined
    return value === undefined || isReservedEnvName(name)
      ? []
      : [[name, Redacted.make(value)] as const]
  })
  return new Map([...base, ...own])
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
  /** The block's own `env` prop, filled in (`ownEnv`). It holds no reserved name. */
  readonly own: RunEnv
}

/**
 * The block's `env` prop with each value's `{{ }}` filled in from what the
 * run reads, as the run starts. A field or output that is not there fails
 * the run before it starts; the message names each variable and reference,
 * never a value.
 */
export const ownEnv = (
  env: Readonly<Record<string, string>>,
  reads: ValueSources,
): Effect.Effect<RunEnv, TaskFailed> => {
  const filled: Record<string, Redacted.Redacted<string>> = {}
  const problems: string[] = []
  for (const [name, template] of Object.entries(env)) {
    const value = renderValueTemplate(template, reads)
    if (Result.isSuccess(value)) filled[name] = value.success
    else problems.push(`${name} in env: ${value.failure.message}`)
  }
  return problems.length === 0
    ? Effect.succeed(filled)
    : Effect.fail(new TaskFailed({ message: problems.join(" ") }))
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
  for (const [name, value] of Object.entries(own)) env.set(name, value)
  const built: RunEnv = Object.fromEntries(env)
  const tooLarge = sizeProblem(built, (name) =>
    Object.hasOwn(own, name) ? OWN : (setBy.get(name) ?? BASE),
  )
  if (tooLarge !== undefined) return yield* Effect.fail(tooLarge)
  return { env: built, conflicts }
})

const BASE = { layer: "the base environment" } as const
const OWN = { layer: "the block's env" } as const

/** Where a variable of a run's environment came from: the block that gave it, or another layer. */
type Origin = BlockId | typeof BASE | typeof OWN

/**
 * Why no process can be started with `env`, or undefined: a variable a
 * block gave past `RUN_ENV_LIMITS.variableBytes`, or the whole past
 * `totalBytes`. The
 * message names each variable and where it came from, and for the whole,
 * the layers that gave the most; never a value.
 */
function sizeProblem(env: RunEnv, originOf: (name: string) => Origin): TaskFailed | undefined {
  const bytesBy = new Map<Origin, number>()
  const reasons: string[] = []
  let total = 0
  for (const [name, value] of Object.entries(env)) {
    const origin = originOf(name)
    const bytes = variableBytes(name, Redacted.value(value))
    // The base environment is the one this process was started with, so this
    // system takes its variables, however large; Linux would have refused one
    // past the bound before Runbooks started. It still counts in the whole.
    if (origin !== BASE && bytes > RUN_ENV_LIMITS.variableBytes)
      reasons.push(
        `${name} ${where(origin)} is ${bytes} bytes as NAME=value with its NUL, over the ${RUN_ENV_LIMITS.variableBytes} bytes a process can take for one variable.`,
      )
    total += bytes + POINTER_BYTES
    bytesBy.set(origin, (bytesBy.get(origin) ?? 0) + bytes + POINTER_BYTES)
  }
  if (total > RUN_ENV_LIMITS.totalBytes) {
    const most = [...bytesBy]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([origin, bytes]) => `${label(origin)} (${bytes} bytes)`)
    reasons.push(
      `The run's environment is ${total} bytes, over the ${RUN_ENV_LIMITS.totalBytes} bytes a process can be started with. Most of it came from ${most.length > 1 ? `${most.slice(0, -1).join(", ")} and ${most.at(-1)}` : most[0]}.`,
    )
  }
  return reasons.length === 0
    ? undefined
    : new TaskFailed({ message: [...reasons, "So the run did not start."].join(" ") })
}

const label = (origin: Origin): string => (typeof origin === "string" ? origin : origin.layer)

const where = (origin: Origin): string =>
  typeof origin === "string"
    ? `from ${origin}`
    : origin === BASE
      ? "in the base environment"
      : "in env"
