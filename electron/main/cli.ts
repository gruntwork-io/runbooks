/**
 * CLI argument parsing for desktop app launch.
 *
 * When the app is invoked from the command line (e.g. `runbooks ./path/to/file.mdx`)
 * we parse argv to extract configuration that gets forwarded to the IPC runtime.
 */
import path from "path"
import { isRemoteURL } from "./remote.ts"
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
 * working directory is always the folder that contains the runbook, and
 * generated files always go inside it. We still recognize these flags so their
 * value is skipped instead of being taken as the runbook path.
 */
const UNSUPPORTED_VALUE_FLAGS = new Set(["--working-dir", "--output-path"])

/**
 * Parse process.argv and return a typed config object.
 *
 * Electron passes its own flags in argv, so we skip anything that looks like
 * an Electron/Chromium internal flag (starts with `--` and is not one of ours).
 *
 * @param argv    The arguments to parse: this process's argv, or the argv a
 *                second instance forwards through Electron's "second-instance"
 *                event.
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

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const flagName = arg.split("=", 1)[0]

    if (arg === "--runbook" && i + 1 < args.length) {
      const val = args[++i]
      if (isRemoteURL(val)) {
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
        `${flagName} is no longer supported and was ignored: the working directory is ` +
          "always the runbook's folder, and generated files are written inside it.",
      )
    } else if (!arg.startsWith("-") && isRemoteURL(arg)) {
      // Treat a bare positional URL as a remote runbook. This runs before the
      // path filters below so a URL is never discarded as a script path.
      config.remoteUrl = arg
    } else if (
      !arg.startsWith("-") &&
      !arg.endsWith(".js") &&
      !arg.endsWith(".ts") &&
      !arg.includes("node_modules")
    ) {
      // Treat other bare positional arguments as a runbook path, except the
      // app's own path in an unpackaged run.
      const resolved = path.resolve(cwd, arg)
      if (appPath === undefined || resolved !== path.resolve(appPath)) {
        config.runbookPath = resolved
      }
    }
  }

  return config
}
