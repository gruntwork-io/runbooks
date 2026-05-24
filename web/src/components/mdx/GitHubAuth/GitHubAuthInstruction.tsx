import { useMemo } from 'react'
import { LogIn } from 'lucide-react'
import { Instruction } from '@/components/mdx/_shared'
import { useTemplateContext } from '@/contexts/useRunbook'
import { resolveTemplateReferences } from '@/lib/templateUtils'
import type { GitHubAuthProps } from './types'

/**
 * Instruction-mode rendering of a GitHubAuth block (spec §6.4): a plain "Log
 * into GitHub" instruction noting the scopes the block declares. No OAuth/PAT
 * UI, no token capture. Kept consistent with AwsAuthInstruction per AGENTS.md.
 *
 * Separate component (not a branch inside GitHubAuth) so the interactive path's
 * `useGitHubAuth` hook never runs while the mode is on.
 */
export function GitHubAuthInstruction({
  id,
  description,
  oauthScopes = ['repo'],
  inputsId,
}: GitHubAuthProps) {
  const templateCtx = useTemplateContext(inputsId)

  const resolvedDescription = useMemo(
    () => (description ? resolveTemplateReferences(description, templateCtx) : undefined),
    [description, templateCtx],
  )

  return (
    <Instruction
      id={id}
      icon={LogIn}
      title="Log into GitHub"
      description={resolvedDescription}
      note={
        oauthScopes.length > 0 ? (
          <span>
            Make sure your login has these scopes:{' '}
            {oauthScopes.map((scope, i) => (
              <span key={scope}>
                {i > 0 && ', '}
                <code className="font-mono">{scope}</code>
              </span>
            ))}
            .
          </span>
        ) : undefined
      }
    />
  )
}
