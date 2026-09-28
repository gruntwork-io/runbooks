/**
 * CLI argument parsing for desktop app launch.
 *
 * When the app is invoked from the command line (e.g. `runbooks ./path/to/file.mdx`)
 * we parse argv to extract configuration that gets forwarded to the IPC runtime.
 */
import path from "path"
import { isRemoteSource } from "../../src/remote-source.ts"
import { makeLogger } from "./logger.ts"

const log = makeLogger("cli")

export interface CliConfig {
  /** Path to a runbook file to open on launch, if provided. */
  runbookPath: string | null
  /** Remote URL to open on launch, if provided. */
  remoteUrl: string | null
  /** Enable watch mode for live-reloading. */
  watch: boolean
  /** Disable telemetry. */
  noTelemetry: boolean
  /** Freeze the executable registry in watch mode (don't rebuild on file changes). */
  disableLiveFileReload: boolean
}

/**
 * Value-taking flags from the old Go CLI that this app does not support. The
 * working directory starts as the folder that contains the runbook (and then
 * follows any `cd` a script makes), and generated files always go inside that
 * folder. We still recognize these flags so their value is skipped instead of
 * being taken as the runbook path.
 */
const UNSUPPORTED_VALUE_FLAGS = new Set(["--working-dir", "--output-path"])

/**
 * Parse process.argv and return a typed config object.
 *
 * Electron passes its own flags in argv, so we skip anything that looks like
 * an Electron/Chromium internal flag (starts with `--` and is not one of ours).
 *
 * @param argv    The arguments to parse: this process's argv, or a second
 *                instance's argv from the "second-instance" event (see
 *                secondInstanceArgv).
 * @param cwd     The directory relative paths are resolved against. For a
 *                second instance this is the directory it was launched from
 *                (Electron's `workingDirectory`), not this process's cwd.
 * @param appPath The Electron app's own path (`app.getAppPath()`). An
 *                unpackaged run (`electron .`, as electron-vite dev does)
 *                passes it as a positional argument, and it is not a runbook.
 */
export function parseCliArgs(
  argv: string[] = process.argv,
  cwd: string = process.cwd(),
  appPath?: string,
): CliConfig {
  // Electron packaged apps: argv[0] is the executable.
  // In dev (electron-vite dev): argv[0] is electron, argv[1] is the app path.
  // We skip known leading entries and work with the rest.
  const args = argv.slice(1).filter((a) => !a.startsWith("--inspect"))

  const config: CliConfig = {
    runbookPath: null,
    remoteUrl: null,
    watch: false,
    noTelemetry: false,
    disableLiveFileReload: false,
  }
  // Whether a positional (a source, or the `open` subcommand) has been seen.
  let sawPositional = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const flagName = arg.split("=", 1)[0]

    if (arg === "--runbook" && i + 1 < args.length) {
      const val = args[++i]
      if (isRemoteSource(val)) {
        config.remoteUrl = val
      } else {
        config.runbookPath = path.resolve(cwd, val)
      }
    } else if (arg === "--watch") {
      config.watch = true
    } else if (arg === "--no-telemetry") {
      config.noTelemetry = true
    } else if (arg === "--disable-live-file-reload") {
      config.disableLiveFileReload = true
    } else if (UNSUPPORTED_VALUE_FLAGS.has(flagName)) {
      // `--flag value` form: skip the value too (the `--flag=value` form is one arg).
      if (arg === flagName && i + 1 < args.length && !args[i + 1].startsWith("-")) i++
      log.warn(
        `${flagName} is no longer supported and was ignored: the working directory starts ` +
          "in the runbook's folder, and generated files are written inside that folder.",
      )
    } else if (isRemoteSource(arg)) {
      // Treat a bare positional source as a remote runbook. This runs before
      // the path filters below so a source is never discarded as a script path.
      config.remoteUrl = arg
      sawPositional = true
    } else if (
      !arg.startsWith("-") &&
      !arg.endsWith(".js") &&
      !arg.endsWith(".ts") &&
      !arg.includes("node_modules")
    ) {
      // Treat other bare positional arguments as a runbook path, except the
      // app's own path in an unpackaged run, and a first `open`: that is the
      // documented `runbooks open SOURCE` subcommand, which the installed
      // launcher passes through. A folder named "open" is reachable as ./open.
      const resolved = path.resolve(cwd, arg)
      if (appPath !== undefined && resolved === path.resolve(appPath)) continue
      if (arg !== "open" || sawPositional) config.runbookPath = resolved
      sawPositional = true
    }
  }

  return config
}

/**
 * The argv to parse for a second instance. Electron's "second-instance" `argv`
 * is not the list the second instance was started with: Chromium moves every
 * switch ahead of the positionals and adds switches of its own, so
 * `--working-dir /path` no longer sits next to its value. The second instance
 * therefore forwards its own process.argv as the lock's additionalData
 * (`app.requestSingleInstanceLock({ argv: process.argv })`). Use that when it
 * is a string array, and fall back to Electron's `argv` otherwise.
 */
export function secondInstanceArgv(argv: string[], additionalData: unknown): string[] {
  const forwarded = (additionalData as { argv?: unknown } | null | undefined)?.argv
  if (Array.isArray(forwarded) && forwarded.every((a) => typeof a === "string")) {
    return forwarded
  }
  return argv
}
