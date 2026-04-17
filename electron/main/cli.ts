/**
 * CLI argument parsing for desktop app launch.
 *
 * When the app is invoked from the command line (e.g. `runbooks ./path/to/file.mdx`)
 * we parse argv to extract configuration that gets forwarded to the IPC runtime.
 */
import path from "path"
import { isRemoteURL } from "./remote.ts"

export interface CliConfig {
  /** Path to a runbook file to open on launch, if provided. */
  runbookPath: string | null
  /** Remote URL to open on launch, if provided. */
  remoteUrl: string | null
  /** Enable watch mode for live-reloading. */
  watch: boolean
  /** Override the output path for generated files. */
  outputPath: string | null
  /** Disable telemetry. */
  noTelemetry: boolean
  /** Freeze the executable registry in watch mode (don't rebuild on file changes). */
  disableLiveFileReload: boolean
}

/**
 * Parse process.argv and return a typed config object.
 *
 * Electron passes its own flags in argv, so we skip anything that looks like
 * an Electron/Chromium internal flag (starts with `--` and is not one of ours).
 */
export function parseCliArgs(argv: string[] = process.argv): CliConfig {
  // Electron packaged apps: argv[0] is the executable.
  // In dev (electron-vite dev): argv[0] is electron, argv[1] is the script.
  // We skip known leading entries and work with the rest.
  const args = argv.slice(1).filter((a) => !a.startsWith("--inspect"))

  const config: CliConfig = {
    runbookPath: null,
    remoteUrl: null,
    watch: false,
    outputPath: null,
    noTelemetry: false,
    disableLiveFileReload: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === "--runbook" && i + 1 < args.length) {
      const val = args[++i]
      if (isRemoteURL(val)) {
        config.remoteUrl = val
      } else {
        config.runbookPath = path.resolve(val)
      }
    } else if (arg === "--watch") {
      config.watch = true
    } else if (arg === "--output-path" && i + 1 < args.length) {
      config.outputPath = path.resolve(args[++i])
    } else if (arg === "--no-telemetry") {
      config.noTelemetry = true
    } else if (arg === "--disable-live-file-reload") {
      config.disableLiveFileReload = true
    } else if (
      !arg.startsWith("-") &&
      !arg.endsWith(".js") &&
      !arg.endsWith(".ts") &&
      !arg.includes("electron") &&
      !arg.includes("node_modules") &&
      arg !== "."
    ) {
      // Treat bare positional arguments as a runbook path or remote URL.
      if (isRemoteURL(arg)) {
        config.remoteUrl = arg
      } else {
        config.runbookPath = path.resolve(arg)
      }
    }
  }

  return config
}
