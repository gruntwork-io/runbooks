import type { AppError } from "@/types/error"
import type { FormLookups } from "../../../../../../src/domain/boilerplate/lookups"

/** What's wrong with the lookups a block's boilerplate.yml declares, shown in place of the block. */
export function lookupsError(block: string, lookups: FormLookups | undefined): AppError | null {
  if (!lookups || lookups.problems.length === 0) return null
  return {
    message: `The ${block} block's boilerplate.yml declares lookups it can't use.`,
    details: lookups.problems.join("\n"),
  }
}
