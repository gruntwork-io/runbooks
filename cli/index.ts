/**
 * CLI entry point for the runbooks test runner.
 * Standalone Node.js binary that reuses src/ modules directly (no IPC, no Electron).
 */
import { Command } from "commander"
import { registerTestCommand } from "./commands/test.ts"

const program = new Command()

program
  .name("runbooks-cli")
  .description("Gruntwork Runbooks CLI tools")
  .version("0.1.0")

registerTestCommand(program)

program.parse()
