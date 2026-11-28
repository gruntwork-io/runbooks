#!/usr/bin/env bun
/**
 * The `runbooks` binary. It reads the process's arguments, environment and
 * working directory, runs the command over the Node layers, and sets the
 * process's exit code. Nothing else here reads the process.
 */
import { writeSync } from "node:fs"
import { constants } from "node:os"
import { Effect, Layer } from "effect"
import * as registry from "@runbooks/blocks"
import { fakeScripts } from "@runbooks/blocks/fakes"
import { fakeCredentialProviders } from "@runbooks/core/credential/fake"
import { ChildProcessSpawnerLive } from "@runbooks/platform-node/layers/ChildProcessSpawner"
import { NodeCliEnvironmentLive } from "@runbooks/platform-node/layers/NodeCliEnvironment"
import { NodeFileSystemLive } from "@runbooks/platform-node/layers/NodeFileSystem"
import { appVersion } from "./appVersion.ts" with { type: "macro" }
import { runCli } from "./cli.ts"

const env: Record<string, string> = {}
for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value

/** What the next Ctrl-C or SIGTERM does while `runbooks test` waits for one: stop the run. */
let onStop: (() => void) | undefined

/** The first Ctrl-C or SIGTERM while `runbooks test` runs. */
const interrupted = Effect.callback<void>((resume) => {
  onStop = () => resume(Effect.void)
  return Effect.sync(() => {
    onStop = undefined
  })
})

/**
 * Ctrl-C (SIGINT) and SIGTERM. The first, while `runbooks test` runs, stops
 * the run, and a stopped script gets the spawner's grace to end. Any other
 * stops the process at once: as it exits, the spawner kills every process
 * group it has not seen end. The exit code is the one the command gave, if
 * it has ended; otherwise 128 plus the signal's number, as a shell reports
 * a process the signal killed.
 */
const onSignal = (signal: "SIGINT" | "SIGTERM") => {
  const stop = onStop
  onStop = undefined
  if (stop !== undefined) return stop()
  writeSync(2, "Stopped at once: any script still running was killed.\n")
  process.exit(
    typeof process.exitCode === "number" ? process.exitCode : 128 + constants.signals[signal],
  )
}
process.on("SIGINT", () => onSignal("SIGINT"))
process.on("SIGTERM", () => onSignal("SIGTERM"))

process.exitCode = await Effect.runPromise(
  runCli(process.argv.slice(2), {
    registry,
    appVersion: appVersion(),
    cwd: process.cwd(),
    credentialProviders: fakeCredentialProviders(fakeScripts),
    env,
    interrupted,
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeCliEnvironmentLive, NodeFileSystemLive, ChildProcessSpawnerLive),
    ),
  ),
)
