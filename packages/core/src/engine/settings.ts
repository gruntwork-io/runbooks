/**
 * The settings store: the one owner of every setting. It serves
 * `GetSettings`, `ChangeSettings` and `WatchSettings`, and the engine reads
 * the settings a credential provider opens with from it.
 *
 * The settings file (`SettingsFile`) holds
 * `{ "version": SETTINGS_VERSION, "settings": { ... } }`, and `settings`
 * holds only what a person set: the rest take `DEFAULT_SETTINGS`, so a
 * default can change in a later version. Reading the file never fails the
 * engine and never loses what the file holds:
 *
 * - No file: the defaults.
 * - A setting whose value this version does not take, or that it does not
 *   know: the default applies, a problem names it, and the file keeps it.
 * - A newer version: the settings this version knows apply, and every
 *   change is refused, since writing would lose the rest.
 * - Not settings (not JSON, too large, no version): the defaults apply, and
 *   the file is copied aside before a change replaces it.
 * - The file cannot be read, or cannot be copied aside: the defaults apply,
 *   and every change is refused.
 *
 * A change writes back every value the file held, even one this version
 * cannot read, apart from the settings the change names.
 */
import { Context, Effect, Layer, Option, PubSub, Result, Schema, Semaphore, Stream } from "effect"
import { errorMessage } from "../errors/message.ts"
import type { FileHead } from "../services/FileSystem.ts"
import { MAX_SETTINGS_BYTES, SettingsFile } from "../services/SettingsFile.ts"
import {
  Caller,
  type ChangeSettingsResult,
  Forbidden,
  type Settings,
  SettingsChange,
  SettingsNotSaved,
  type SettingsProblem,
  type SettingsView,
} from "./protocol.ts"

/**
 * The version of the settings file this release reads and writes. Adding a
 * setting does not raise it: an older release keeps a setting it does not
 * know. Renaming or removing one, or changing what its values mean, does,
 * and comes with the step that reads the version before.
 */
export const SETTINGS_VERSION = 1

/** Each setting's value until a person sets it. */
export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  instructionMode: false,
  runbookWidth: null,
  askAboutGeneratedFiles: true,
  caBundleFile: null,
  proxy: null,
  agentAccess: false,
  confirmAgentRuns: true,
  recentGitHubHosts: [],
  lastSelectedGitHubHost: null,
  recentGitLabHosts: [],
  lastSelectedGitLabHost: null,
}

export interface SettingsStoreShape {
  /** `GetSettings`. */
  readonly get: Effect.Effect<SettingsView>
  /**
   * `ChangeSettings`, person only. Saves the settings `changes` names, then
   * applies them; if the file cannot be written, nothing changes.
   */
  readonly change: (
    changes: SettingsChange,
  ) => Effect.Effect<ChangeSettingsResult, Forbidden | SettingsNotSaved, Caller>
  /** `WatchSettings`: the settings now, then again after each change, the latest only for a reader that falls behind. */
  readonly watch: Stream.Stream<SettingsView>
}

/** The most settings one file holds, known or not. A file with more is not settings. */
const MAX_SETTINGS = 64

/** What the settings file holds, before each setting is read. */
const SettingsFileContent = Schema.Struct({
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  settings: Schema.Record(Schema.String, Schema.Unknown).check(
    Schema.isMaxProperties(MAX_SETTINGS),
  ),
})

type ReadOnly = Extract<SettingsProblem, { readonly _tag: "Unreadable" | "Newer" }>

/** What the store holds: the file's settings as read, and what this version takes of them. */
interface Held {
  /** The file's `settings`, every value as it was: a change writes them back. */
  readonly stored: Readonly<Record<string, unknown>>
  /** The settings in `stored` this version takes. The rest take their defaults. */
  readonly chosen: SettingsChange
  readonly problems: ReadonlyArray<SettingsProblem>
  /** Why a change is refused: replacing the file would lose what it holds. */
  readonly readOnly: Option.Option<ReadOnly>
}

const EMPTY: Held = { stored: {}, chosen: {}, problems: [], readOnly: Option.none() }

const decodeContent = Schema.decodeUnknownResult(SettingsFileContent)
const decodeChange = Schema.decodeUnknownResult(SettingsChange)

/** The settings in `stored` this version takes, and a problem for each it does not. */
function settingsIn(stored: Readonly<Record<string, unknown>>): {
  readonly chosen: SettingsChange
  readonly problems: ReadonlyArray<SettingsProblem>
} {
  const taken: Record<string, unknown> = {}
  const problems: SettingsProblem[] = []
  for (const [setting, value] of Object.entries(stored)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, setting)) {
      problems.push({ _tag: "UnknownSetting", setting })
      continue
    }
    const one = decodeChange({ [setting]: value })
    if (Result.isSuccess(one)) taken[setting] = value
    else problems.push({ _tag: "InvalidSetting", setting, message: one.failure.message })
  }
  // Each value was decoded on its own above, so this cannot fail.
  return { chosen: Schema.decodeUnknownSync(SettingsChange)(taken), problems }
}

/** What the settings file's text holds: settings this version reads, a newer version's, or no settings at all. */
type Content =
  | { readonly _tag: "Settings"; readonly held: Held }
  | { readonly _tag: "NotSettings"; readonly reason: string }

function contentOf(head: FileHead): Content {
  if (head.truncated)
    return { _tag: "NotSettings", reason: `It is larger than ${MAX_SETTINGS_BYTES} bytes.` }
  let json: unknown
  try {
    json = JSON.parse(head.text)
  } catch (error) {
    return { _tag: "NotSettings", reason: `It is not JSON: ${errorMessage(error)}` }
  }
  const content = decodeContent(json)
  if (Result.isFailure(content)) return { _tag: "NotSettings", reason: content.failure.message }
  const { version, settings: stored } = content.success
  const { chosen, problems } = settingsIn(stored)
  if (version > SETTINGS_VERSION) {
    const newer: ReadOnly = { _tag: "Newer", version }
    return {
      _tag: "Settings",
      held: { stored, chosen, problems: [newer], readOnly: Option.some(newer) },
    }
  }
  return { _tag: "Settings", held: { stored, chosen, problems, readOnly: Option.none() } }
}

/** The settings file's text for `stored`. */
const textOf = (stored: Readonly<Record<string, unknown>>): string =>
  `${JSON.stringify({ version: SETTINGS_VERSION, settings: stored }, null, 2)}\n`

export class SettingsStore extends Context.Service<SettingsStore, SettingsStoreShape>()(
  "@runbooks/core/engine/SettingsStore",
) {
  /** Reads the settings file once, as the module comment says, and keeps it from then on. */
  static readonly layer: Layer.Layer<SettingsStore, never, SettingsFile> = Layer.effect(
    SettingsStore,
    Effect.gen(function* () {
      const file = yield* SettingsFile
      const unreadable = (reason: string): Held => {
        const problem: ReadOnly = { _tag: "Unreadable", reason }
        return { ...EMPTY, problems: [problem], readOnly: Option.some(problem) }
      }
      const load: Effect.Effect<Held> = file.read.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(EMPTY),
            onSome: (head) => {
              const content = contentOf(head)
              if (content._tag === "Settings") return Effect.succeed(content.held)
              const { reason } = content
              return file.keepAside.pipe(
                Effect.map((keptAt): Held => ({
                  ...EMPTY,
                  problems: [{ _tag: "KeptAside", reason, keptAt }],
                })),
                Effect.catch((error) =>
                  Effect.succeed(
                    unreadable(
                      `${reason} It could not be copied aside: ${errorMessage(error.cause)}`,
                    ),
                  ),
                ),
              )
            },
          }),
        ),
        Effect.catch((error) =>
          Effect.succeed(unreadable(`It could not be read: ${errorMessage(error.cause)}`)),
        ),
      )

      let held = yield* load
      const lock = yield* Semaphore.make(1)
      /** Wakes each `watch` reader. Each keeps one pending wake at most. */
      const changed = yield* PubSub.sliding<void>(1)

      const view = (): SettingsView => ({
        settings: { ...DEFAULT_SETTINGS, ...held.chosen },
        file: file.path,
        problems: held.problems,
      })

      const save = (changes: SettingsChange) =>
        Effect.gen(function* () {
          const named = Object.keys(changes)
          const stored = { ...held.stored, ...Schema.encodeSync(SettingsChange)(changes) }
          const text = textOf(stored)
          if (new TextEncoder().encode(text).length > MAX_SETTINGS_BYTES)
            return yield* new SettingsNotSaved({
              file: file.path,
              message: `The settings would be larger than ${MAX_SETTINGS_BYTES} bytes.`,
            })
          yield* file
            .replace(text)
            .pipe(
              Effect.mapError(
                (error) =>
                  new SettingsNotSaved({ file: file.path, message: errorMessage(error.cause) }),
              ),
            )
          held = {
            stored,
            chosen: { ...held.chosen, ...changes },
            problems: held.problems.filter(
              (problem) => problem._tag !== "InvalidSetting" || !named.includes(problem.setting),
            ),
            readOnly: Option.none(),
          }
          yield* PubSub.publish(changed, undefined)
        })

      return SettingsStore.of({
        get: Effect.sync(view),

        change: (changes) =>
          Effect.gen(function* () {
            const { origin } = yield* Caller
            if (origin !== "person")
              return yield* new Forbidden({ command: "ChangeSettings", origin })
            // A transport decoded `changes`; an in-process caller may not have.
            // Decoding keeps only the settings the protocol has.
            const decoded = yield* Effect.orDie(Schema.decodeUnknownEffect(SettingsChange)(changes))
            return yield* lock.withPermit(
              Effect.gen(function* () {
                if (Option.isSome(held.readOnly))
                  return { _tag: "ReadOnly", problem: held.readOnly.value } as const
                yield* save(decoded)
                return { _tag: "Changed", settings: view() } as const
              }),
            )
          }),

        watch: Stream.unwrap(
          Effect.map(PubSub.subscribe(changed), (wake) =>
            Stream.paginate(true, (first: boolean) =>
              Effect.map(
                first ? Effect.void : PubSub.take(wake),
                () => [[view()], Option.some(false)] as const,
              ),
            ),
          ),
        ),
      })
    }),
  )
}
