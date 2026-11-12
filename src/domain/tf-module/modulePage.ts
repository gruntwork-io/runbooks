/**
 * The module's folder on GitHub, for a link from the <TfModule> block to the
 * code behind its form. It shows the ref the block reads: a remote source's
 * `?ref=`, or, for a folder beside the runbook, the tag its checkout is at,
 * else its commit.
 */
import { Effect } from "effect"
import { isRemoteSource } from "../../remote-source.ts"
import { gitLines } from "./git.ts"
import { moduleSourceInfo } from "./moduleSource.ts"
import { gitSourceAddress } from "./pinnedSource.ts"

const first = (lines: readonly string[] | undefined) => lines?.[0]?.trim() || undefined

/** The page, or nothing when the module isn't on GitHub. */
export const modulePage = (source: string, moduleDir: string) =>
  Effect.gen(function* () {
    if (isRemoteSource(source)) return moduleSourceInfo(source).url
    const origin = first(yield* gitLines(moduleDir, ["remote", "get-url", "origin"]))
    const address = origin ? gitSourceAddress(origin) : undefined
    if (!address) return undefined
    const ref =
      first(yield* gitLines(moduleDir, ["describe", "--tags", "--exact-match", "HEAD"])) ??
      first(yield* gitLines(moduleDir, ["rev-parse", "HEAD"]))
    if (!ref) return undefined
    const folder = (
      first(yield* gitLines(moduleDir, ["rev-parse", "--show-prefix"])) ?? ""
    ).replace(/\/$/, "")
    return moduleSourceInfo(`${address}${folder ? `//${folder}` : ""}?ref=${ref}`).url
  })
