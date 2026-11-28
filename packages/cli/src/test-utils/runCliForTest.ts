/**
 * Runs `runbooks <argv>` in process, as the entry point does, over the real
 * Node file system, and gives what it wrote to stdout and stderr and its exit
 * code. Each test passes its own folder as the working directory and the
 * environment as a value, so nothing reads the real process's.
 */
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Console, Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect"
import { ChildProcessSpawner } from "effect/process"
import type { Registry } from "@runbooks/blocks-core/registry"
import type { CredentialProviders } from "@runbooks/core/credential/provider"
import { FileSystem as RunbooksFileSystem } from "@runbooks/core/services/FileSystem"
import { NodeFileSystemLive } from "@runbooks/platform-node/layers/NodeFileSystem"
import { type ExitCode, runCli } from "../cli.ts"
import { NoCredentialProviders } from "../testIsolation.ts"

export interface CliRun {
  readonly code: ExitCode
  readonly stdout: string
  readonly stderr: string
}

const unused = Effect.die("unused")

/** effect/cli's services, with no terminal and nothing read from the real process. */
const parserLayer = Layer.mergeAll(
  Path.layer,
  Stdio.layerTest({}),
  FileSystem.layerNoop({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(100),
      rows: Effect.succeed(24),
      size: unused,
      readInput: unused,
      readLine: unused,
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => unused),
  ),
)

export interface RunOptions {
  readonly registry: Registry
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  /** The file system the command sees. The real Node one by default. */
  readonly fileSystem?: Layer.Layer<RunbooksFileSystem>
  /** Completes when the test presses Ctrl-C. Never, by default. */
  readonly interrupted?: Effect.Effect<void>
  /** What credential blocks sign in with. None can be opened, by default. */
  readonly credentialProviders?: Layer.Layer<CredentialProviders, never, RunbooksFileSystem>
}

export async function runCliForTest(
  argv: ReadonlyArray<string>,
  options: RunOptions,
): Promise<CliRun> {
  const stdout: string[] = []
  const stderr: string[] = []
  const console: Console.Console = {
    ...globalThis.console,
    log: (...args: ReadonlyArray<unknown>) => {
      stdout.push(args.join(" "))
    },
    error: (...args: ReadonlyArray<unknown>) => {
      stderr.push(args.join(" "))
    },
  }
  const code = await Effect.runPromise(
    runCli(argv, {
      registry: options.registry,
      appVersion: "0.31.0",
      cwd: options.cwd,
      env: options.env ?? {},
      interrupted: options.interrupted ?? Effect.never,
      credentialProviders: options.credentialProviders ?? NoCredentialProviders,
    }).pipe(
      Effect.provide(Layer.merge(parserLayer, options.fileSystem ?? NodeFileSystemLive)),
      Effect.provideService(Console.Console, console),
    ),
  )
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") }
}

/** A fresh folder under the system's temporary folder, removed by `remove`. */
export function tempFolder(): { readonly path: string; readonly remove: () => void } {
  const folder = mkdtempSync(path.join(os.tmpdir(), "runbooks-cli-test-"))
  return { path: folder, remove: () => rmSync(folder, { recursive: true, force: true }) }
}
