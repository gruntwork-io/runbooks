import { usePageBlocks } from "@/contexts/ComponentIdRegistry"
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
 */
export function useBindingError(
  declarations: { definitions: Definitions; groups: readonly string[] } | undefined,
  auth: Readonly<Record<string, string>>,
  block: string,
  whose: string,
): AppError | null {
  const { blockOf, registered } = usePageBlocks()
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
