/**
 * MCP command: serves the runbook tools over stdio, for an AI agent such as
 * Claude Code to run a runbook headless. See cli/mcp/server.ts.
 */
import type { Command } from "commander"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { createMcpServer } from "../mcp/server.ts"

export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("Serve Model Context Protocol tools over stdio for running runbooks headless")
    .action(() => {
      // stdout carries the protocol, so anything the engine logs goes to stderr
      console.log = console.error
      console.info = console.error
      serveStdio(createMcpServer)
    })
}
