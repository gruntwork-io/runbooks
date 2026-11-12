import { usePageBlocks } from "@/contexts/ComponentIdRegistry"
import { useScopeRequests } from "@/contexts/ScopeRequests"
import type { AppError } from "@/types/error"
import type { Definitions } from "../../../../../../src/domain/lookups/types"
import { bindingProblems } from "../../../../../../src/domain/lookups/validate"

/**
 * What's wrong with how a block's `auth` prop binds the lookup groups it uses
 * to the runbook's auth blocks, once its declarations are read and the blocks
 * on the page have registered.
 *
 * `block` names the block, such as `<TfModule>`, and `whose` the file its
 * lookups come from, such as "the module's".
 *
 * It also asks each bound auth block for the scopes its groups declare, so an
 * auth block requests them at sign-in without the runbook listing them.
 */
export function useBindingError(
  declarations: { definitions: Definitions; groups: readonly string[] } | undefined,
  auth: Readonly<Record<string, string>>,
  block: string,
  whose: string,
): AppError | null {
  const { blockOf, registered } = usePageBlocks()
  useScopeRequests(declarations ? scopesByBlock(declarations, auth) : {})
  if (!declarations || !registered) return null
  const blocks = Object.values(auth).flatMap((blockId) => {
    const found = blockOf(blockId)
    return found ? [{ id: blockId, kind: found.kind, scopes: found.scopes }] : []
  })
  const problems = bindingProblems(declarations.definitions, declarations.groups, auth, blocks)
  if (problems.length === 0) return null
  return {
    message: `The ${block} block's auth prop doesn't fit ${whose} lookups.`,
    details: problems.join("\n"),
  }
}

/** The scopes each auth block the binding names must request, by its id. */
function scopesByBlock(
  declarations: { definitions: Definitions; groups: readonly string[] },
  auth: Readonly<Record<string, string>>,
): Record<string, readonly string[]> {
  const scopes: Record<string, string[]> = {}
  for (const name of declarations.groups) {
    const group = declarations.definitions.groups[name]
    const blockId = auth[name]
    if (!group || !blockId) continue
    scopes[blockId] = [...(scopes[blockId] ?? []), ...group.scopes]
  }
  return scopes
}
