/**
 * How a <TerragruntApply> block binds its module's checks to the auth blocks
 * its `auth` prop lists, and what its preflight's findings mean for the plan.
 * The block learns the module only at preflight, so a binding problem shows
 * there. Pure, so the rules are tested without the main process.
 */
import type { TerragruntPreflight } from "../../../../../electron/shared/channels"
import type { CheckOutcome } from "../../../../../src/domain/lookups/run"
import type { Definitions, Use } from "../../../../../src/domain/lookups/types"
import {
  bindingProblems,
  usedGroups,
  type BoundBlock,
} from "../../../../../src/domain/lookups/validate"

/**
 * Each group the checks use, bound to the block in `auth` of the kind it
 * needs, and the problems: a kind with no block, or a block without the
 * group's scopes.
 */
export function bindByKind(
  definitions: Definitions,
  preflight: readonly Use[],
  auth: readonly BoundBlock[],
): { binding: Record<string, string>; problems: string[] } {
  const groups = usedGroups(definitions, [], preflight)
  const binding: Record<string, string> = {}
  const problems: string[] = []
  for (const name of groups) {
    const kind = definitions.groups[name]?.auth
    if (!kind) continue
    const block = auth.find((candidate) => candidate.kind === kind)
    if (block) binding[name] = block.id
    else {
      problems.push(
        `The module's ${name} checks need ${/^[AEIOU]/.test(kind) ? "an" : "a"} ${kind} block. Add one to the block's auth prop.`,
      )
    }
  }
  return {
    binding,
    problems: [
      ...problems,
      ...bindingProblems(definitions, Object.keys(binding), binding, [...auth]),
    ],
  }
}

/** What the preflight found, once it's run. */
export type PreflightState =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "error"; readonly error: string }
  | Exclude<TerragruntPreflight, { kind: "ready" }>
  | (Extract<TerragruntPreflight, { kind: "ready" }> & {
      /** The auth prop's problems for the module's checks. */
      readonly problems: readonly string[]
      readonly results: readonly { readonly use: Use; readonly outcome: CheckOutcome }[]
    })

/**
 * What the findings mean for the plan: `go` plans, `stop` waits for a fix,
 * and `ask` waits for the user to plan anyway, after a check that couldn't
 * run.
 */
export function verdictOf(state: PreflightState): "go" | "stop" | "ask" | "pending" {
  switch (state.kind) {
    case "idle":
    case "running":
      return "pending"
    case "error":
    case "missing-tools":
    case "unpushed":
      return "stop"
    case "ready":
      if (state.problems.length > 0) return "stop"
      if (state.results.some((r) => r.outcome.outcome === "failed")) return "stop"
      if (state.moduleNote || state.results.some((r) => r.outcome.outcome === "unknown")) {
        return "ask"
      }
      return "go"
  }
}
