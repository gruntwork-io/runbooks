/**
 * Doubles that write down every call made to a service, in one list across
 * services, so a test can assert on all the I/O some code did rather than
 * on a few spies. Each call is noted when it runs, not when it is built.
 */
import { Effect, Stream } from "effect"
import type { FileSystemShape } from "../services/FileSystem.ts"
import type { ProcessSpawnerShape } from "../services/ProcessSpawner.ts"

export interface ServiceCall {
  readonly service: "FileSystem" | "ProcessSpawner"
  readonly method: string
  readonly args: ReadonlyArray<unknown>
}

const noter = (service: ServiceCall["service"], calls: ServiceCall[]) => ({
  effect: <A, E>(method: string, args: ReadonlyArray<unknown>, run: () => Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      calls.push({ service, method, args })
      return run()
    }),
  stream: <A, E>(method: string, args: ReadonlyArray<unknown>, run: () => Stream.Stream<A, E>) =>
    Stream.suspend(() => {
      calls.push({ service, method, args })
      return run()
    }),
})

/** `inner`, noting each call in `calls`. */
export function recordFileSystem(inner: FileSystemShape, calls: ServiceCall[]): FileSystemShape {
  const { effect, stream } = noter("FileSystem", calls)
  return {
    readFile: (...args) => effect("readFile", args, () => inner.readFile(...args)),
    readFileBuffer: (...args) =>
      effect("readFileBuffer", args, () => inner.readFileBuffer(...args)),
    readdir: (...args) => effect("readdir", args, () => inner.readdir(...args)),
    readdirWithTypes: (...args) =>
      effect("readdirWithTypes", args, () => inner.readdirWithTypes(...args)),
    stat: (...args) => effect("stat", args, () => inner.stat(...args)),
    exists: (...args) => effect("exists", args, () => inner.exists(...args)),
    writeFile: (...args) => effect("writeFile", args, () => inner.writeFile(...args)),
    appendFile: (...args) => effect("appendFile", args, () => inner.appendFile(...args)),
    mkdir: (...args) => effect("mkdir", args, () => inner.mkdir(...args)),
    rm: (...args) => effect("rm", args, () => inner.rm(...args)),
    copyFile: (...args) => effect("copyFile", args, () => inner.copyFile(...args)),
    mkdtemp: (...args) => effect("mkdtemp", args, () => inner.mkdtemp(...args)),
    realpath: (...args) => effect("realpath", args, () => inner.realpath(...args)),
    isContainedInReal: (...args) =>
      effect("isContainedInReal", args, () => inner.isContainedInReal(...args)),
    walk: (...args) => stream("walk", args, () => inner.walk(...args)),
    watch: (...args) => stream("watch", args, () => inner.watch(...args)),
  }
}

/** `inner`, noting each call in `calls`. */
export function recordProcessSpawner(
  inner: ProcessSpawnerShape,
  calls: ServiceCall[],
): ProcessSpawnerShape {
  const { effect } = noter("ProcessSpawner", calls)
  return { spawn: (...args) => effect("spawn", args, () => inner.spawn(...args)) }
}
