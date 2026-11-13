/**
 * The module source that code a <TfModule> block writes into a repository
 * uses. The form, the template and the module must come from the same
 * release, so that code points at a tag:
 *
 * - A `source` that's a folder beside the runbook names a module in the
 *   runbook's own repository. The code uses that repository's URL at the tag
 *   its checkout is at, which is the ref the runbook was opened at.
 * - A remote `source` names its own `?ref=`, which must be a tag.
 */
import { Effect } from "effect"
import { TfModuleError } from "../../errors/index.ts"
import { gitLines } from "./git.ts"
import { moduleSourceInfo } from "./moduleSource.ts"

const fail = (message: string) => new TfModuleError({ message })

/** The first line git printed, trimmed, or nothing. */
const first = (lines: readonly string[] | undefined) => lines?.[0]?.trim() || undefined

/**
 * A remote's URL as an OpenTofu Git source address, without credentials:
 * `git::https://host/owner/repo.git`, or `git::ssh://git@host/owner/repo.git`
 * for an scp-like address such as `git@host:owner/repo.git`.
 */
export function gitSourceAddress(url: string): string | undefined {
  const scp = /^([\w.-]+)@([\w.-]+):(?!\/\/)(.+)$/.exec(url)
  if (scp) return `git::ssh://${scp[1]}@${scp[2]}/${scp[3]}`
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return undefined
  if (parsed.protocol === "https:") {
    parsed.username = ""
    parsed.password = ""
  } else {
    parsed.password = ""
  }
  return `git::${parsed.toString().replace(/\/$/, "")}`
}

/** What HEAD is, for a message: its branch, or its short commit. */
const describeHead = (dir: string) =>
  Effect.gen(function* () {
    const branch = first(yield* gitLines(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]))
    if (branch) return `the branch ${branch}`
    const commit = first(yield* gitLines(dir, ["rev-parse", "--short", "HEAD"]))
    return commit ? `the commit ${commit}` : "no commit"
  })

/**
 * The source for a module in a folder of a Git checkout: the checkout's
 * `origin` at the tag HEAD is at. Fails, naming the ref, when HEAD isn't
 * exactly at a tag or the module has uncommitted changes.
 */
export const localModuleSource = (moduleDir: string) =>
  Effect.gen(function* () {
    const top = first(yield* gitLines(moduleDir, ["rev-parse", "--show-toplevel"]))
    if (!top) {
      return yield* fail(
        "The module isn't in a Git repository, so code in a repository has no release of it to point at. Open the runbook from its repository at a tag.",
      )
    }
    const tag = first(yield* gitLines(moduleDir, ["describe", "--tags", "--exact-match", "HEAD"]))
    if (!tag) {
      const head = yield* describeHead(moduleDir)
      return yield* fail(
        `The runbook is open at ${head}, which isn't a tag. Code it writes points at its module's release, so open the runbook at a tag, such as with ?ref=v1.2.0.`,
      )
    }
    // The module's folder from the repository's root, as git spells it, with a trailing slash.
    const prefix = yield* gitLines(moduleDir, ["rev-parse", "--show-prefix"])
    const folder = (first(prefix) ?? "").replace(/\/$/, "")
    const changed = yield* gitLines(moduleDir, ["status", "--porcelain", "--", "."])
    if (changed === undefined || changed.some((line) => line.trim() !== "")) {
      return yield* fail(
        `The module has changes that aren't in ${tag}, so ${tag} isn't the module the form shows. Commit them and tag a release, or discard them.`,
      )
    }
    const origin = first(yield* gitLines(moduleDir, ["remote", "get-url", "origin"]))
    const address = origin ? gitSourceAddress(origin) : undefined
    if (!address) {
      return yield* fail(
        "The runbook's repository has no origin remote that code elsewhere can fetch the module from.",
      )
    }
    return `${address}${folder ? `//${folder}` : ""}?ref=${tag}`
  })

/**
 * Checks that a remote source's `?ref=` is a tag in its clone at `moduleDir`,
 * and returns the source as given.
 */
export const remoteModuleSource = (source: string, moduleDir: string) =>
  Effect.gen(function* () {
    const { ref } = moduleSourceInfo(source)
    if (!ref) {
      return yield* fail(
        "The source has no ?ref=, so code that uses it would follow the module's default branch. Pin it to a tag, such as ?ref=v1.2.0.",
      )
    }
    const tags = yield* gitLines(moduleDir, ["tag", "--points-at", "HEAD"])
    if (!tags?.map((tag) => tag.trim()).includes(ref)) {
      return yield* fail(
        `The source's ref, ${ref}, isn't a tag. Code that uses the module points at a release, so pin it to a tag, such as ?ref=v1.2.0.`,
      )
    }
    return source
  })
