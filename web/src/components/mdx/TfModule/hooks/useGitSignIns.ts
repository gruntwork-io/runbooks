import { useRunbookContext } from "@/contexts/useRunbook"

/**
 * Who's signed in to GitHub or GitLab, as GitAuth blocks published it: a key
 * that changes on each sign-in, so a module a remote source couldn't clone
 * without one can be read again.
 */
export function useGitSignIns(): string {
  const { blockOutputs } = useRunbookContext()
  return JSON.stringify(
    Object.values(blockOutputs)
      .filter((outputs) => outputs.values.GIT_PROVIDER !== undefined)
      .map((outputs) => [outputs.values.GIT_PROVIDER, outputs.timestamp]),
  )
}
