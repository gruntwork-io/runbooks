/**
 * What effect's command-line parser (`effect/cli`) asks of the process: the
 * standard streams and whether each is a terminal (`Stdio`), the terminal's
 * size (`Terminal`) and `Path`. The `runbooks` entry point passes the
 * arguments in itself.
 *
 * The CLI reads nothing from standard input and declares no file flag and no
 * prompt, so the parser never calls its `FileSystem` or `ChildProcessSpawner`.
 * The first finds no file; the second fails, naming what was asked of it.
 */
import { Effect, FileSystem, Layer, Path, Sink, Stdio, Stream, Terminal } from "effect"
import { ChildProcessSpawner } from "effect/process"

const unused = (what: string) =>
  Effect.die(new Error(`The runbooks CLI does not use ${what}: no flag or prompt asks for it.`))

const writeTo = (stream: NodeJS.WriteStream) => () =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.sync(() => {
      stream.write(chunk)
    }),
  )

const stdio = Stdio.make({
  args: Effect.sync(() => process.argv.slice(2)),
  stdout: writeTo(process.stdout),
  stderr: writeTo(process.stderr),
  stdin: Stream.empty,
  stdinIsTerminal: Effect.sync(() => process.stdin.isTTY === true),
  stdoutIsTerminal: Effect.sync(() => process.stdout.isTTY === true),
  stderrIsTerminal: Effect.sync(() => process.stderr.isTTY === true),
})

/** A terminal's size when standard output is not one. */
const DEFAULT_COLUMNS = 80
const DEFAULT_ROWS = 24

const terminal = Terminal.make({
  columns: Effect.sync(() => process.stdout.columns ?? DEFAULT_COLUMNS),
  rows: Effect.sync(() => process.stdout.rows ?? DEFAULT_ROWS),
  size: unused("the terminal's size changes"),
  readInput: unused("keyboard input"),
  readLine: unused("a typed line"),
  display: (text) =>
    Effect.sync(() => {
      process.stdout.write(text)
    }),
})

export const NodeCliEnvironmentLive = Layer.mergeAll(
  Path.layer,
  Layer.succeed(Stdio.Stdio, stdio),
  Layer.succeed(Terminal.Terminal, terminal),
  FileSystem.layerNoop({}),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => unused("a child process")),
  ),
)
