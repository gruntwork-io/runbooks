import { useMemo } from 'react'
import { GitPullRequest as GitPullRequestIcon } from 'lucide-react'
import { Instruction } from '@/components/mdx/_shared'
import { useTemplateContext, useAllOutputs } from '@/contexts/useRunbook'
import { resolveTemplateReferences } from '@/lib/templateUtils'
import { buildGhPrCommand, buildGlabMrCommand } from '@/components/mdx/_shared/lib/instructionCommands'
import { deriveProviderFromAuth } from '@/components/mdx/_shared/lib/gitProvider'
import { PR_PROVIDERS } from './providers'
import { WrongProviderError } from './components/WrongProviderError'
import type { GitPullRequestProps } from './types'

/**
 * Instruction-mode rendering of a GitPullRequest block (spec §6.4): a copyable
 * `gh pr create` / `glab mr create` command, with a note to push the branch
 * first. No push, no PR/MR is created. Separate component so the interactive
 * path's `useGitPullRequest` IPC never runs.
 *
 * The wrong-auth-block guard (req #4) must also hold here, because the outer
 * entry branches to instruction mode BEFORE useGitPullRequest runs — so this
 * component independently derives the provider and renders the same blocking
 * error instead of a (wrong-provider) command.
 */
export function GitPullRequestInstruction({
  id,
  description,
  prefilledPullRequestTitle = '',
  prefilledPullRequestDescription = '',
  prefilledPullRequestLabels = [],
  prefilledBranchName = '',
  inputsId,
  githubAuthId,
  gitAuthId,
  provider: propProvider,
}: GitPullRequestProps) {
  const templateContext = useTemplateContext(inputsId)
  const rawOutputs = useAllOutputs()

  // Provider derivation. Instruction mode has no active clone, so (unlike the
  // interactive block) there's no worktree-host fallback: a locked wrapper sets
  // `provider`; otherwise derive from the linked auth block, defaulting to
  // github for display.
  const authId = gitAuthId ?? githubAuthId
  const authDerivedProvider = deriveProviderFromAuth(authId, rawOutputs)
  const effectiveProvider = propProvider ?? authDerivedProvider ?? 'github'
  const cfg = PR_PROVIDERS[effectiveProvider]

  const wrongProvider =
    !!authId && authDerivedProvider !== undefined && authDerivedProvider !== cfg.id

  const descriptionText = description ?? `Open a ${cfg.noun.lower} with your changes`

  const resolvedDescription = useMemo(
    () => (descriptionText ? resolveTemplateReferences(descriptionText, templateContext) : undefined),
    [descriptionText, templateContext],
  )
  const resolvedBranch = useMemo(
    () =>
      prefilledBranchName
        ? resolveTemplateReferences(prefilledBranchName, templateContext)
        : '',
    [prefilledBranchName, templateContext],
  )

  // Build from the RAW prefilled props (templates intact) so <Instruction>
  // resolves inputs and surfaces manual fields for output references. The body's
  // \n escapes are expanded up front (matching the interactive block).
  const command = useMemo(
    () => {
      const body = prefilledPullRequestDescription.replace(/\\n/g, '\n')
      return cfg.instruction.build === 'glab'
        ? buildGlabMrCommand({ title: prefilledPullRequestTitle, description: body, labels: prefilledPullRequestLabels })
        : buildGhPrCommand({ title: prefilledPullRequestTitle, body, labels: prefilledPullRequestLabels })
    },
    [cfg, prefilledPullRequestTitle, prefilledPullRequestDescription, prefilledPullRequestLabels],
  )

  // Wrong-auth-block guard — render the blocking error instead of a command that
  // would target the wrong provider.
  if (wrongProvider && authDerivedProvider) {
    return (
      <div data-testid={id} className="runbook-block relative rounded-sm border bg-destructive-muted/10 border-destructive/30 mb-5 p-4">
        <WrongProviderError cfg={cfg} authDerivedProvider={authDerivedProvider} />
      </div>
    )
  }

  return (
    <Instruction
      id={id}
      icon={GitPullRequestIcon}
      title={cfg.instruction.cliTitle}
      description={resolvedDescription}
      command={command}
      templateContext={templateContext}
      note={
        <span>
          Commit and push your branch first
          {resolvedBranch && !resolvedBranch.includes('{{') ? (
            <>
              {' '}(<code className="font-mono">{resolvedBranch}</code>)
            </>
          ) : null}
          , then run the command above from the repository directory.
        </span>
      }
    />
  )
}
