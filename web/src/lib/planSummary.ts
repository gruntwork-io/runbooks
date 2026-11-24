/**
 * Plan summaries for the renderer. The implementation lives in
 * src/domain/exec/planSummary.ts, where the main process builds them.
 */
import { z } from "zod"
import type { PlanSummary as Summary } from "../../../src/domain/exec/planSummary"

export {
  hasChanges,
  type PlanAction,
  type PlanAttributeChange,
  type PlanCounts,
  type PlanResourceChange,
  type PlanSummary,
  type PlanUnit,
} from "../../../src/domain/exec/planSummary"

const ActionSchema = z.enum([
  "create",
  "update",
  "delete",
  "replace",
  "import",
  "forget",
  "move",
  "read",
])

const CountsSchema = z.object({
  add: z.number(),
  change: z.number(),
  destroy: z.number(),
  replace: z.number(),
  import: z.number(),
  forget: z.number(),
  move: z.number(),
})

/** A plan summary as the session's history saves it. */
export const PlanSummarySchema: z.ZodType<Summary> = z.object({
  totals: CountsSchema,
  units: z.array(
    z.object({
      name: z.string(),
      planned: z.boolean(),
      errored: z.boolean().exactOptional(),
      error: z.string().exactOptional(),
      counts: CountsSchema,
      resources: z.array(
        z.object({
          address: z.string(),
          action: ActionSchema,
          previousAddress: z.string().exactOptional(),
          importing: z.boolean().exactOptional(),
          attributes: z.array(
            z.object({
              path: z.string(),
              before: z.string().exactOptional(),
              after: z.string().exactOptional(),
              unknownAfter: z.boolean().exactOptional(),
              sensitive: z.boolean().exactOptional(),
              forcesReplacement: z.boolean().exactOptional(),
            }),
          ),
          omittedAttributes: z.number().exactOptional(),
        }),
      ),
      omittedResources: z.number().exactOptional(),
      outputs: z.array(z.object({ name: z.string(), action: ActionSchema })),
      result: z.enum(["succeeded", "failed", "early exit", "excluded"]).exactOptional(),
      reason: z.string().exactOptional(),
      cause: z.string().exactOptional(),
    }),
  ),
})
