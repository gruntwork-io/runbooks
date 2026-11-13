/**
 * Reads what a repository's base branch holds where a <TfModule> block's
 * unit lands, so the unit shows as added or changed against that branch
 * rather than against a checkout a plan or a pull request has written to.
 */
import { Effect } from "effect"
import { gitLines as git } from "./git.ts"

/** The commit to compare with: the base branch, its remote copy, or HEAD. */
const baseCommit = (worktree: string, baseBranch: string | undefined) =>
  Effect.gen(function* () {
    const refs = baseBranch ? [baseBranch, `origin/${baseBranch}`, "HEAD"] : ["HEAD"]
    for (const ref of refs) {
      const sha = yield* git(worktree, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
      if (sha?.[0]?.trim()) return sha[0].trim()
    }
    return undefined
  })

/**
 * The files the base branch holds directly in each of `folders` ("" for the
 * root) and at each of `paths`, by path from the repository's root. Empty when
 * the checkout has no commit to compare with. Git hands back lines, so each
 * file reads as its lines, each ending in a newline.
 */
export const filesAtBase = (
  worktree: string,
  baseBranch: string | undefined,
  folders: readonly string[],
  paths: readonly string[],
) =>
  Effect.gen(function* () {
    const files = new Map<string, string>()
    const commit = yield* baseCommit(worktree, baseBranch)
    if (!commit) return files
    const read = (rel: string) =>
      Effect.map(git(worktree, ["show", `${commit}:${rel}`]), (lines) => {
        if (lines) files.set(rel, lines.map((line) => `${line}\n`).join(""))
      })
    for (const folder of folders) {
      const listing = yield* git(worktree, ["ls-tree", commit, ...(folder ? [`${folder}/`] : [])])
      for (const entry of listing ?? []) {
        // "<mode> <type> <object>\t<path>"; git quotes a path with unusual characters, which is skipped.
        const [meta, rel] = entry.split("\t")
        if (rel && !rel.startsWith('"') && meta?.split(" ")[1] === "blob") yield* read(rel)
      }
    }
    for (const rel of paths) yield* read(rel)
    return files
  })
