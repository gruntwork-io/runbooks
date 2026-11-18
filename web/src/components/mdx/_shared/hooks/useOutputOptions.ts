import { useMemo } from "react"
import { useAllOutputs } from "@/contexts/useRunbook"
import { isSensitiveOutput } from "@/lib/outputValues"
import { normalizeBlockId } from "@/lib/utils"
import type { BoilerplateVariable } from "@/types/boilerplateVariable"
import {
  describeOptionsSource,
  optionFields,
  parseOutputOptions,
} from "../../../../../../src/domain/boilerplate/options"
import { useOutputDependencyStatus } from "./useOutputDependencyStatus"

/** Where the options of a variable whose options come from a block's output stand. */
export type OutputOptionsStatus =
  /** The block hasn't produced the output yet: the ids of the blocks to wait for, as written. */
  | { kind: "waiting"; waitingFor: string[] }
  /** No block on the page has the id the reference names. */
  | { kind: "missing"; missing: string[] }
  /** The output isn't a list of options; the message says why. */
  | { kind: "error"; message: string }
  | { kind: "resolved" }

interface OutputOptions {
  /** The variables, with the options of each one whose options come from an output in place once read. */
  variables: BoilerplateVariable[]
  /** By variable name, for each variable whose options come from an output. */
  status: Record<string, OutputOptionsStatus>
}

/**
 * The options of the variables whose `options` or `x-options` name a block
 * output (`{{ fromJson .outputs.list_regions.regions }}`), read from that
 * output now. A variable waits like a value that uses an output does (see
 * useOutputDependencyStatus), and its options update when the block runs
 * again. A variable with options written in the YAML is passed through as it
 * is.
 */
export function useOutputOptions(variables: readonly BoilerplateVariable[]): OutputOptions {
  const allOutputs = useAllOutputs()
  const outputStatus = useOutputDependencyStatus()

  return useMemo(() => {
    const status: Record<string, OutputOptionsStatus> = {}
    const resolved = variables.map((variable) => {
      const reference = variable.optionsFrom
      if (!reference) return variable

      const { waitingFor, missing } = outputStatus(reference.expression)
      if (missing.length > 0) {
        status[variable.name] = { kind: "missing", missing }
        return variable
      }
      if (waitingFor.length > 0) {
        status[variable.name] = { kind: "waiting", waitingFor }
        return variable
      }

      const output = allOutputs[normalizeBlockId(reference.blockId)]?.values[reference.outputName]
      // The options are shown, so a sensitive output can't be one.
      if (output !== undefined && isSensitiveOutput(output)) {
        status[variable.name] = {
          kind: "error",
          message: `The options come from ${describeOptionsSource(reference)}, which is sensitive, so it can't be shown as options.`,
        }
        return variable
      }
      const parsed = parseOutputOptions(reference, output)
      if (!parsed.ok) {
        status[variable.name] = { kind: "error", message: parsed.error }
        return variable
      }
      status[variable.name] = { kind: "resolved" }
      return { ...variable, ...optionFields(parsed.items) }
    })
    return { variables: resolved, status }
  }, [variables, allOutputs, outputStatus])
}
