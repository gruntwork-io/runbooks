/**
 * Reading a run's plan directory (RUNBOOK_PLAN_DIR) into a plan summary.
 */
import { Effect, Stream } from "effect"
import { FileSystem } from "../../services/FileSystem.ts"
import {
  MAX_PLAN_FILE_BYTES,
  summarizePlanDir,
  type PlanDirFile,
  type PlanSummary,
} from "./planSummary.ts"

/**
 * The summary of the plans and run report a script wrote to `dir`, or null
 * when it wrote none. A file that can't be read or parsed shows as a unit
 * with an error; a directory that can't be walked gives null.
 */
export const readPlanDir = (dir: string): Effect.Effect<PlanSummary | null, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const entries = yield* Stream.runCollect(fs.walk(dir))
    const files: PlanDirFile[] = []
    for (const entry of entries) {
      if (!entry.isFile || !entry.relativePath.toLowerCase().endsWith(".json")) continue
      const relativePath = entry.relativePath.split("\\").join("/")
      if (entry.size > MAX_PLAN_FILE_BYTES) {
        files.push({
          relativePath,
          content: {
            error: `The plan file is ${Math.round(entry.size / 1024 / 1024)} MiB, over the ${MAX_PLAN_FILE_BYTES / 1024 / 1024} MiB Runbooks reads.`,
          },
        })
        continue
      }
      const content = yield* fs.readFile(entry.path).pipe(
        Effect.map((text) => {
          try {
            return { json: JSON.parse(text) as unknown }
          } catch {
            return { error: "The file isn't valid JSON." }
          }
        }),
        Effect.catch(() => Effect.succeed({ error: "The file couldn't be read." })),
      )
      files.push({ relativePath, content })
    }
    return summarizePlanDir(files)
  }).pipe(Effect.catch(() => Effect.succeed(null)))
