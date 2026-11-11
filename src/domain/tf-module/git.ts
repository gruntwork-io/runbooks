/** Runs git for a <TfModule> block's own reads of a checkout. */
import { Effect } from "effect"
import { collectOutput, ProcessSpawner } from "../../services/ProcessSpawner.ts"
import { gitSpawnEnv } from "../git/env.ts"

/** How long one git command may take before it counts as failed. */
const GIT_TIMEOUT_MS = 15_000

/** Runs git in `dir`. Returns stdout's lines, or nothing when git fails. */
export const gitLines = (dir: string, args: string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ProcessSpawner
    const proc = yield* spawner.spawn("git", args, { cwd: dir, env: gitSpawnEnv() })
    const { exitCode, lines } = yield* collectOutput(proc, GIT_TIMEOUT_MS)
    if (exitCode !== 0) return undefined
    return lines.filter((l) => l.source === "stdout").map((l) => l.line)
  }).pipe(Effect.orElseSucceed(() => undefined))
