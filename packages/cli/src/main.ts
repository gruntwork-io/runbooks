#!/usr/bin/env bun
/**
 * The `runbooks` binary. It reads the process's arguments, environment and
 * working directory, runs the command over the Node layers, and sets the
 * process's exit code. Nothing else here reads the process.
 */
import { Effect, Layer } from "effect"
import * as registry from "@runbooks/blocks"
import { NodeCliEnvironmentLive } from "@runbooks/platform-node/layers/NodeCliEnvironment"
import { NodeFileSystemLive } from "@runbooks/platform-node/layers/NodeFileSystem"
import { appVersion } from "./appVersion.ts" with { type: "macro" }
import { runCli } from "./cli.ts"

const env: Record<string, string> = {}
for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value

/**
 * The first Ctrl-C. The listener is gone after it, so a second one stops the
 * process at once, as Ctrl-C does by default.
 */
const interrupted = Effect.callback<void>((resume) => {
  const onSigint = () => resume(Effect.void)
  process.once("SIGINT", onSigint)
  return Effect.sync(() => process.off("SIGINT", onSigint))
})

process.exitCode = await Effect.runPromise(
  runCli(process.argv.slice(2), {
    registry,
    appVersion: appVersion(),
    cwd: process.cwd(),
    env,
    interrupted,
  }).pipe(Effect.provide(Layer.merge(NodeCliEnvironmentLive, NodeFileSystemLive))),
)
