/**
 * The settings today's app keeps in files of its own, in its data folder,
 * read once: on the first start with no settings file. The settings store
 * keeps what this version takes of them.
 *
 * Only the main process's files are read. What the window kept in its own
 * storage (instruction mode, the runbook's width, the generated-files
 * prompt) is not a file the engine can read, so those start from their
 * defaults.
 *
 * Nothing here writes, renames or removes a file: today's app, run again,
 * finds its files as it left them.
 */
import path from "node:path"
import { Effect, Schema } from "effect"
import { FileSystem } from "../services/FileSystem.ts"
import { Settings } from "./protocol.ts"

/** The most of each file read. Today's are a few hundred bytes. */
export const MAX_LEGACY_FILE_BYTES = 64 * 1024

/** Today's files, by name in its data folder. */
export const LEGACY_FILES = {
  /** `{ path }`: the PEM file the person chose. */
  customCa: "custom-ca.json",
  /** `{ theme }`. */
  theme: "theme.json",
  /** `{ enabled, confirmRuns }`. */
  agentAccess: "agent-access.json",
  /** `{ recentGitHubHosts, lastSelectedGitHubHost, recentGitLabHosts, lastSelectedGitLabHost }`. */
  vcsAuth: "vcs-auth.json",
} as const

/** As many as today's app keeps, and the settings take. */
const MAX_RECENT_HOSTS = 5

const isHost = Schema.is(Settings.fields.lastSelectedGitHubHost)

/** The hosts in `value` a setting takes, in order, each once. */
const hostsIn = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? Array.from(
        new Set(value.filter((host): host is string => typeof host === "string" && isHost(host))),
      ).slice(0, MAX_RECENT_HOSTS)
    : []

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The settings today's files in `folder` hold, by this version's names, as
 * today's app reads them. A value is as the file holds it: the store keeps
 * only those this version takes. A file that is missing, cannot be read,
 * is larger than `MAX_LEGACY_FILE_BYTES` or is not a JSON object gives
 * nothing, as today's app reads it as its defaults.
 */
export const readLegacySettings = (
  folder: string,
): Effect.Effect<Readonly<Record<string, unknown>>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const read = (name: string) =>
      fs.readFileUpTo(path.join(folder, name), MAX_LEGACY_FILE_BYTES).pipe(
        Effect.map(({ text, truncated }) => {
          if (truncated) return undefined
          try {
            const json: unknown = JSON.parse(text)
            return isObject(json) ? json : undefined
          } catch {
            return undefined
          }
        }),
        Effect.catch(() => Effect.succeed(undefined)),
      )

    const customCa = yield* read(LEGACY_FILES.customCa)
    const theme = yield* read(LEGACY_FILES.theme)
    const agentAccess = yield* read(LEGACY_FILES.agentAccess)
    const vcsAuth = yield* read(LEGACY_FILES.vcsAuth)
    return {
      ...(customCa === undefined ? {} : { caBundleFile: customCa.path }),
      ...(theme === undefined ? {} : { theme: theme.theme }),
      // As today's app reads them: off unless `true`, confirmed unless `false`.
      ...(agentAccess === undefined
        ? {}
        : {
            agentAccess: agentAccess.enabled === true,
            confirmAgentRuns: agentAccess.confirmRuns !== false,
          }),
      ...(vcsAuth === undefined
        ? {}
        : {
            recentGitHubHosts: hostsIn(vcsAuth.recentGitHubHosts),
            lastSelectedGitHubHost: vcsAuth.lastSelectedGitHubHost,
            recentGitLabHosts: hostsIn(vcsAuth.recentGitLabHosts),
            lastSelectedGitLabHost: vcsAuth.lastSelectedGitLabHost,
          }),
    }
  })
