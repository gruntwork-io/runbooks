import { useMemo } from 'react'
import { GitPullRequest } from 'lucide-react'
import { Instruction } from '@/components/mdx/_shared'
import { useTemplateContext } from '@/contexts/useRunbook'
import { resolveTemplateReferences } from '@/lib/templateUtils'
import { buildGhPrCommand } from '@/components/mdx/_shared/lib/instructionCommands'
import type { GitHubPullRequestProps } from './types'

/**
 * Instruction-mode rendering of a GitHubPullRequest block (spec §6.4): a
 * copyable `gh pr create --title … --body … [--label …]`, with a note to push
 * the branch first. No push, no PR is created. Separate component so the
 * interactive path's `useGitHubPullRequest` IPC never runs.
 */
export function GitHubPullRequestInstruction({
  id,
  description = 'Open a pull request with your changes',
  prefilledPullRequestTitle = '',
  prefilledPullRequestDescription = '',
  prefilledPullRequestLabels = [],
  prefilledBranchName = '',
  inputsId,
}: GitHubPullRequestProps) {
  const templateContext = useTemplateContext(inputsId)

  const resolvedDescription = useMemo(
    () => (description ? resolveTemplateReferences(description, templateContext) : undefined),
    [description, templateContext],
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
    () =>
      buildGhPrCommand({
        title: prefilledPullRequestTitle,
        body: prefilledPullRequestDescription.replace(/\\n/g, '\n'),
        labels: prefilledPullRequestLabels,
      }),
    [prefilledPullRequestTitle, prefilledPullRequestDescription, prefilledPullRequestLabels],
  )

  return (
    <Instruction
      id={id}
      icon={GitPullRequest}
      title="Open a pull request:"
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
