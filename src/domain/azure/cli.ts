import { Effect } from "effect"
import {
  ProcessSpawner,
  collectOutput,
  type SpawnedProcess,
} from "../../services/ProcessSpawner.ts"
import { Environment } from "../../services/Environment.ts"
import { AzureAuthError } from "../../errors/index.ts"

const AZ_TIMEOUT_MS = 60_000

export const AZ_MISSING_MESSAGE =
  "The Azure CLI (az) isn't installed, or isn't on your PATH. Install it from https://learn.microsoft.com/cli/azure/install-azure-cli, then try again."

export interface AzContext {
  readonly configDir: string
  readonly extensionDir?: string | undefined
}

const azEnv = (ctx: AzContext) =>
  Effect.gen(function* () {
    const env = yield* Environment
    const all: Record<string, string> = { ...(yield* env.getAll()) }
    if (ctx.configDir) {
      delete all.AZURE_EXTENSION_DIR
      all.AZURE_CONFIG_DIR = ctx.configDir
    }
    if (ctx.extensionDir) all.AZURE_EXTENSION_DIR = ctx.extensionDir
    return {
      ...all,
      AZURE_CORE_LOGIN_EXPERIENCE_V2: "off",
      AZURE_CORE_NO_COLOR: "true",
      AZURE_CORE_ONLY_SHOW_ERRORS: "true",
      AZURE_CORE_COLLECT_TELEMETRY: "false",
      AZURE_CORE_SURVEY_MESSAGE: "false",
    }
  })

export function azCommand(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform !== "win32") return { command: "az", args: [...args] }
  const line = ["az", ...args].map((arg) => `"${arg.replace(/"/g, '""')}"`).join(" ")
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    windowsVerbatimArguments: true,
  }
}

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

const notRecognized = (stderr: readonly string[]) =>
  stderr.some((line) => /'az' is not recognized/.test(line))

export const spawnAz = (ctx: AzContext, args: readonly string[], stdin?: string) =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const env = yield* azEnv(ctx)
    const { command, args: argv, windowsVerbatimArguments } = azCommand(args)
    return yield* spawner
      .spawn(command, argv, {
        env,
        ...(stdin !== undefined ? { stdin } : {}),
        ...(windowsVerbatimArguments ? { windowsVerbatimArguments } : {}),
      })
      .pipe(
        Effect.mapError((err) => {
          const missing = isMissingBinary(err.cause)
          return new AzureAuthError({
            message: missing ? AZ_MISSING_MESSAGE : `Could not run az: ${String(err.cause)}`,
            cliMissing: missing,
            command: `az ${args[0] ?? ""}`,
            cause: err,
          })
        }),
      )
  })

export function azFailure(stderr: readonly string[], command: string): AzureAuthError {
  const missing = notRecognized(stderr)
  return new AzureAuthError({
    message: missing ? AZ_MISSING_MESSAGE : azErrorLine(stderr),
    cliMissing: missing,
    command,
  })
}

interface RunOptions {
  readonly display?: string
  readonly stdin?: string
}

export const runAz = (
  ctx: AzContext,
  args: readonly string[],
  options: RunOptions = {},
): Effect.Effect<string, AzureAuthError, ProcessSpawner | Environment> =>
  Effect.gen(function* () {
    const display = options.display ?? `az ${args.slice(0, 3).join(" ")}`
    const proc: SpawnedProcess = yield* spawnAz(ctx, args, options.stdin)
    const { exitCode, lines } = yield* collectOutput(proc, AZ_TIMEOUT_MS).pipe(
      Effect.mapError(
        () => new AzureAuthError({ message: `${display} timed out`, command: display }),
      ),
    )
    const pick = (source: "stdout" | "stderr") =>
      lines.filter((line) => line.source === source).map((line) => line.line)
    if (exitCode !== 0) return yield* azFailure(pick("stderr"), display)
    return pick("stdout").join("\n")
  })

export const runAzJson = <T>(
  ctx: AzContext,
  args: readonly string[],
  options: RunOptions = {},
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
