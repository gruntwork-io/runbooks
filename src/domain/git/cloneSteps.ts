/**
 * The git commands a `<GitClone>` block runs, shared by the Electron git:clone
 * handler and the test CLI so `runbooks test` clones exactly what the app does.
 *
 * A repo path (`prefilledRepoPath`, or the block's "Repo Path" field) makes it
 * a sparse clone: a blobless clone with no checkout, a cone-mode
 * `sparse-checkout` of that directory, then the checkout. Cone mode also
 * checks out the files directly inside each parent directory of the path,
 * including the repository root, so the result is not the subdirectory alone.
 */
import { Either } from "effect"
import { GitError } from "../../errors/index.ts"

export interface CloneStepOptions {
  /** Branch or tag to clone, passed to `git clone --branch`. */
  readonly ref?: string
  /** Directory to sparse-checkout, relative to the repository root. */
  readonly repoPath?: string
}

/**
 * Normalize a repo path for sparse checkout: trim it, turn `\` into `/` (git
 * paths are always `/`-separated, so a Windows-style `modules\vpc` would
 * otherwise match nothing), and drop a leading `./` and trailing `/`.
 * Succeeds with undefined when the path names the whole repository (`""` or
 * `"."`). Fails for an absolute path or one with a `..` segment, since neither
 * names a directory inside the repository.
 */
export function normalizeRepoPath(
  repoPath: string | undefined,
): Either.Either<string | undefined, GitError> {
  const trimmed = (repoPath ?? "").trim()
  const slashed = trimmed.replace(/\\/g, "/")
  if (/^(?:\/|[A-Za-z]:)/.test(slashed) || slashed.split("/").includes("..")) {
    return Either.left(
      new GitError({
        command: "git sparse-checkout",
        stderr: `invalid repo path "${trimmed}": use a directory inside the repository, relative to its root`,
        exitCode: 1,
      }),
    )
  }
  const normalized = slashed.replace(/^(?:\.\/+)+/, "").replace(/\/+$/, "")
  return Either.right(normalized === "" || normalized === "." ? undefined : normalized)
}

/**
 * The argument lists of the git commands that clone `url` into `dest`, to run
 * in order, stopping at the first failure. Every command addresses `dest`
 * itself (`-C`), so none needs a working directory.
 *
 * In a sparse clone the final `checkout` downloads file contents from the
 * remote (the clone is blobless), so every step, not only `clone`, needs
 * access to the repository's credentials.
 */
export function buildCloneSteps(
  url: string,
  dest: string,
  options: CloneStepOptions = {},
): Either.Either<string[][], GitError> {
  return Either.map(normalizeRepoPath(options.repoPath), (repoPath) => {
    const branch = options.ref ? ["--branch", options.ref] : []
    if (!repoPath) return [["clone", "--progress", ...branch, "--", url, dest]]
    return [
      ["clone", "--filter=blob:none", "--no-checkout", "--progress", ...branch, "--", url, dest],
      // `init --cone` first: before git 2.37, `set` on its own uses
      // non-cone patterns.
      ["-C", dest, "sparse-checkout", "init", "--cone"],
      ["-C", dest, "sparse-checkout", "set", "--", repoPath],
      ["-C", dest, "checkout"],
    ]
  })
}
