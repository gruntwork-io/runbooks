/**
 * CLI argument parsing for desktop app launch.
 *
 * When the app is invoked from the command line (e.g. `runbooks ./path/to/file.mdx`)
 * we parse argv to extract configuration that gets forwarded to the IPC runtime.
 */
import path from "path"

export interface CliConfig {
  /** Path to a runbook file to open on launch, if provided. */
  runbookPath: string | null
  /** Enable watch mode for live-reloading. */
  watch: boolean
  /** Override the working directory for runbook execution. */
  workingDir: string | null
  /** Override the output path for generated files. */
  outputPath: string | null
  /** Disable telemetry. */
  noTelemetry: boolean
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
    watch: false,
    workingDir: null,
    outputPath: null,
    noTelemetry: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === "--runbook" && i + 1 < args.length) {
      config.runbookPath = path.resolve(args[++i])
    } else if (arg === "--watch") {
      config.watch = true
    } else if (arg === "--working-dir" && i + 1 < args.length) {
      config.workingDir = path.resolve(args[++i])
    } else if (arg === "--output-path" && i + 1 < args.length) {
      config.outputPath = path.resolve(args[++i])
    } else if (arg === "--no-telemetry") {
      config.noTelemetry = true
    } else if (!arg.startsWith("-") && !arg.endsWith(".js") && !arg.includes("electron")) {
      // Treat bare positional arguments as a runbook path (e.g. `runbooks ./foo.mdx`).
      config.runbookPath = path.resolve(arg)
    }
  }

  return config
}
