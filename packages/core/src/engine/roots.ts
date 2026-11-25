/**
 * The folders a session's runs use, which the engine sets and no client
 * names, and the guard on each path a task names inside one. They are those
 * of today's app: the runbook's folder; the session's own folder, where a run
 * starts and a clone goes; `generated` in it. `cd` does not carry from one
 * block to the next (ruled 2026-11-23), so the working folder never moves.
 */
import path from "node:path"
import { Effect, Option } from "effect"
import {
  PathOutsideRoot,
  type RepositoryRef,
  type RootedPath,
  type Roots,
  TaskFailed,
} from "@runbooks/blocks-core/contract"
import { FileSystem } from "../services/FileSystem.ts"

/** The folder generated files go to, in the working folder. */
const GENERATED_FOLDER = "generated"

/** The roots of the session `session` for the runbook at `file`: its working folder is its own, in `workingFolders`. */
export const sessionRoots = (file: string, workingFolders: string, session: string): Roots => {
  const working = path.join(workingFolders, session)
  return { runbook: path.dirname(file), working, generated: path.join(working, GENERATED_FOLDER) }
}

/** What one run's paths resolve against: the session's roots, and the repository the task names. */
export interface RunRoots {
  readonly roots: Roots
  readonly repository: Option.Option<RepositoryRef>
}

/**
 * Makes the working folder, then resolves each path a task names inside its
 * root. A path that leaves its root, as written or through a symbolic link,
 * fails the run. So does the path the task makes its repository in, unless
 * it is a folder inside the working folder: the task may delete what is
 * there.
 */
export const resolvePaths = Effect.fnUntraced(function* (
  at: RunRoots,
  named: Readonly<Record<string, RootedPath>>,
  /** Which of `named` the task makes its repository in, if it makes one. */
  repository: string | undefined,
) {
  const fs = yield* FileSystem
  const { working } = at.roots
  yield* fs
    .mkdir(working, { recursive: true })
    .pipe(
      Effect.mapError(
        () => new TaskFailed({ message: `The working folder ${working} could not be made.` }),
      ),
    )
  const resolved: Record<string, string> = {}
  for (const [name, { root, path: written }] of Object.entries(named)) {
    const outside = (message: string) => new PathOutsideRoot({ root, path: written, message })
    const base =
      root === "repository"
        ? Option.map(at.repository, (ref) => ref.path)
        : Option.some(at.roots[root])
    if (Option.isNone(base))
      return yield* outside(`${written} is in a repository, and the block names none.`)
    const absolute = path.resolve(base.value, written)
    // Under both readings of a `..`: as written, and after following a link.
    if (!(yield* fs.isContainedInReal(absolute, base.value)))
      return yield* outside(`${written} is outside the ${root} folder, ${base.value}.`)
    if (name === repository) {
      if (root !== "working")
        return yield* outside(`A repository goes in the working folder, not the ${root} folder.`)
      // Inside each other both ways: it is the working folder itself.
      if (yield* fs.isContainedInReal(base.value, absolute))
        return yield* outside(
          `${written} is the working folder itself; a repository goes in a folder inside it.`,
        )
    }
    resolved[name] = absolute
  }
  return resolved
})
