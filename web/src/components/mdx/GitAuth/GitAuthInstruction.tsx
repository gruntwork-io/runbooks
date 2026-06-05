import { useMemo } from 'react'
import { LogIn } from 'lucide-react'
import { Instruction } from '@/components/mdx/_shared'
import type { BlockComponentType } from '@/contexts/ComponentIdRegistry'
import { useTemplateContext } from '@/contexts/useRunbook'
import { resolveTemplateReferences } from '@/lib/templateUtils'
import type { GitAuthProps } from './types'
import { PROVIDERS } from './providers'

/**
 * Instruction-mode rendering of a GitAuth block (spec §6.4): a plain "Log into
 * GitHub/GitLab" instruction noting the scopes the block declares. No OAuth/PAT
 * UI, no token capture. Kept consistent with AwsAuthInstruction per AGENTS.md.
 *
 * Separate component (not a branch inside GitAuth) so the interactive path's
 * `useGitAuth` hook never runs while the mode is on.
 */
export function GitAuthInstruction({
  id,
  description,
  provider = 'github',
  oauthScopes,
  inputsId,
}: GitAuthProps & { __registryType?: BlockComponentType }) {
  const cfg = PROVIDERS[provider]
  const scopes = oauthScopes ?? cfg.defaultInstructionScopes
  const templateCtx = useTemplateContext(inputsId)

  const resolvedDescription = useMemo(
    () => (description ? resolveTemplateReferences(description, templateCtx) : undefined),
    [description, templateCtx],
  )

  return (
    <Instruction
      id={id}
      icon={LogIn}
      title={`Log into ${cfg.label}`}
      description={resolvedDescription}
      note={
        scopes.length > 0 ? (
          <span>
            Make sure your login has these scopes:{' '}
            {scopes.map((scope, i) => (
              <span key={scope}>
                {i > 0 && ', '}
                <code className="font-mono">{scope}</code>
              </span>
            ))}
            .
            {/* CLI hint only for GitLab; the GitHub note ends after the period,
                preserving the legacy <GitHubAuth> instruction text exactly. */}
            {provider === 'gitlab' && (
              <>
                {' '}Run <code className="font-mono">{cfg.cli.loginCmd}</code>.
              </>
            )}
          </span>
        ) : undefined
      }
    />
  )
}
