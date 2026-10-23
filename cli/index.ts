/**
 * CLI entry point for the runbooks test runner.
 * Standalone Node.js binary that reuses src/ modules directly (no IPC, no Electron).
 */
import { Command } from "commander"
import { registerTestCommand } from "./commands/test.ts"
import { RUNBOOKS_VERSION } from "../src/runbooks-version.ts"

const program = new Command()

program.name("runbooks-cli").description("Gruntwork Runbooks CLI tools").version(RUNBOOKS_VERSION)

registerTestCommand(program)

await program.parseAsync()
