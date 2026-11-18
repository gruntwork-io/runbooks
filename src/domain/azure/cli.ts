/**
 * Running the Azure CLI for AzureAuth.
 *
 * Every call runs in ONE block's config dir (`AZURE_CONFIG_DIR`), so two
 * AzureAuth blocks never share a sign-in, and the user's own `~/.azure` is
 * read only when a block reuses it (see electron/main/ipc/azure-config-dirs.ts,
 * which copies it).
 */
import { Effect } from "effect"
import {
  ProcessSpawner,
  collectOutput,
  type SpawnedProcess,
} from "../../services/ProcessSpawner.ts"
import { Environment } from "../../services/Environment.ts"
import { AzureAuthError } from "../../errors/index.ts"

/** How long a non-interactive az call may take. Sign-in flows have no limit here. */
export const AZ_TIMEOUT_MS = 60_000

/** What to tell a user without the Azure CLI. */
export const AZ_MISSING_MESSAGE =
  "The Azure CLI (az) isn't installed, or isn't on your PATH. Install it from https://learn.microsoft.com/cli/azure/install-azure-cli, then try again."

/**
 * Env vars that steer an az call away from the block's own sign-in, or make it
 * prompt. They are dropped from what az inherits.
 */
const INHERITED_AZ_ENV_TO_DROP = ["AZURE_CONFIG_DIR", "AZURE_EXTENSION_DIR"] as const

/**
 * The environment an az call runs with: the app's own, pointed at `configDir`,
 * with interactive and noisy features off. `extensionDir` keeps the user's
 * installed extensions when the config dir is a copy of theirs.
 */
export const azEnv = (configDir: string, extensionDir?: string) =>
  Effect.gen(function* () {
    const env = yield* Environment
    const all = { ...(yield* env.getAll()) }
    // An empty configDir reads the user's own sign-in, where az looks for it.
    if (configDir) for (const name of INHERITED_AZ_ENV_TO_DROP) delete all[name]
    return {
      ...all,
      ...(configDir ? { AZURE_CONFIG_DIR: configDir } : {}),
      ...(extensionDir ? { AZURE_EXTENSION_DIR: extensionDir } : {}),
      // No subscription picker after `az login`, no colour codes, no
      // "new version available" or preview warnings mixed into stderr.
      AZURE_CORE_LOGIN_EXPERIENCE_V2: "off",
      AZURE_CORE_NO_COLOR: "true",
      AZURE_CORE_ONLY_SHOW_ERRORS: "true",
      AZURE_CORE_COLLECT_TELEMETRY: "false",
      AZURE_CORE_SURVEY_MESSAGE: "false",
    } as Record<string, string>
  })

/** Where an az call runs. */
export interface AzContext {
  /** The block's config dir. Empty reads the user's own (AZURE_CONFIG_DIR, else ~/.azure). */
  readonly configDir: string
  readonly extensionDir?: string | undefined
}

/**
 * The first useful line of az's stderr: the `ERROR:` line when there is one,
 * else the last non-warning line. az prints Python warnings and its own
 * `WARNING:` lines ahead of the error.
 */
export function azErrorLine(stderr: readonly string[]): string {
  const lines = stderr.map((line) => line.trim()).filter((line) => line !== "")
  const error = lines.find((line) => line.startsWith("ERROR:"))
  if (error) return error.replace(/^ERROR:\s*/, "")
  const useful = lines.filter(
    (line) => !line.startsWith("WARNING:") && !/Warning:/.test(line) && !line.startsWith('"""'),
  )
  return useful.at(-1) ?? "az exited with an error"
}

const isMissingBinary = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT"

/** Start an az process in `ctx`. A missing az fails with `cliMissing`. */
export const spawnAz = (ctx: AzContext, args: readonly string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const env = yield* azEnv(ctx.configDir, ctx.extensionDir)
    return yield* spawner.spawn("az", [...args], { env }).pipe(
      Effect.mapError(
        (err) =>
          new AzureAuthError({
            message: isMissingBinary(err.cause)
              ? AZ_MISSING_MESSAGE
              : `Could not run az: ${String(err.cause)}`,
            cliMissing: isMissingBinary(err.cause),
            command: `az ${args[0] ?? ""}`,
            cause: err,
          }),
      ),
    )
  })

/**
 * Run az to completion and return its stdout. A non-zero exit fails with the
 * error line from stderr. `display` names the command in errors without its
 * arguments, which can carry a client secret.
 */
export const runAz = (
  ctx: AzContext,
  args: readonly string[],
  options: { timeoutMs?: number; display?: string } = {},
): Effect.Effect<string, AzureAuthError, ProcessSpawner | Environment> =>
  Effect.gen(function* () {
    const display = options.display ?? `az ${args.slice(0, 3).join(" ")}`
    const proc: SpawnedProcess = yield* spawnAz(ctx, args)
    const { exitCode, lines } = yield* collectOutput(proc, options.timeoutMs ?? AZ_TIMEOUT_MS).pipe(
      Effect.mapError(
        () => new AzureAuthError({ message: `${display} timed out`, command: display }),
      ),
    )
    const pick = (source: "stdout" | "stderr") =>
      lines.filter((line) => line.source === source).map((line) => line.line)
    if (exitCode !== 0) {
      return yield* new AzureAuthError({
        message: azErrorLine(pick("stderr")),
        command: display,
      })
    }
    return pick("stdout").join("\n")
  })

/** Run az with `-o json` and parse what it prints. Empty output parses as undefined. */
export const runAzJson = <T>(
  ctx: AzContext,
  args: readonly string[],
  options: { timeoutMs?: number; display?: string } = {},
): Effect.Effect<T | undefined, AzureAuthError, ProcessSpawner | Environment> =>
  Effect.gen(function* () {
    const stdout = yield* runAz(ctx, [...args, "--only-show-errors", "-o", "json"], options)
    if (stdout.trim() === "") return undefined
    return yield* Effect.try({
      try: () => JSON.parse(stdout) as T,
      catch: (cause) =>
        new AzureAuthError({
          message: `${options.display ?? `az ${args[0]}`} printed something that isn't JSON`,
          cause,
        }),
    })
  })
