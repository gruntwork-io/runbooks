import { useMemo } from 'react'
import { GitBranch } from 'lucide-react'
import { Instruction } from '@/components/mdx/_shared'
import { useTemplateContext } from '@/contexts/useRunbook'
import { resolveTemplateReferences } from '@/lib/templateUtils'
import { buildGitCloneCommand } from '@/components/mdx/_shared/lib/instructionCommands'
import type { GitCloneProps } from './types'

/**
 * Instruction-mode rendering of a GitClone block (spec §6.4): a copyable
 * `git clone [--branch <ref>] <url> [<dir>]`, with a sparse-checkout note when a
 * sub-path is configured. No clone is performed. Built as a separate component
 * so the interactive path's `useGitClone` (session + token IPC) never runs.
 *
 * The raw `prefilled*` props (with `{{ … }}` intact) flow into <Instruction>,
 * which resolves inputs and surfaces manual fields for any output references.
 */
export function GitCloneInstruction({
  id,
  title,
  description = 'Enter a git URL to clone a repository',
  inputsId,
  prefilledUrl = '',
  prefilledRef = '',
  prefilledRepoPath = '',
  prefilledLocalPath = '',
}: GitCloneProps) {
  const templateContext = useTemplateContext(inputsId)

  const resolvedDescription = useMemo(
    () => (description ? resolveTemplateReferences(description, templateContext) : undefined),
    [description, templateContext],
  )
  const resolvedRepoPath = useMemo(
    () => resolveTemplateReferences(prefilledRepoPath, templateContext),
    [prefilledRepoPath, templateContext],
  )

  // Build from the RAW prefilled props so <Instruction> resolves templates and
  // surfaces manual fields for any {{ .outputs.* }} references.
  const command = useMemo(
    () =>
      buildGitCloneCommand({
        url: prefilledUrl,
        ref: prefilledRef || undefined,
        localPath: prefilledLocalPath || undefined,
      }),
    [prefilledUrl, prefilledRef, prefilledLocalPath],
  )

  return (
    <Instruction
      id={id}
      icon={GitBranch}
      title={title ? resolveTemplateReferences(title, templateContext) : 'Clone this repository:'}
      description={resolvedDescription}
      command={command}
      templateContext={templateContext}
      note={
        resolvedRepoPath ? (
          <span>
            Only the sub-path <code className="font-mono">{resolvedRepoPath}</code>{' '}
            is needed — use a{' '}
            <a
              href="https://git-scm.com/docs/git-sparse-checkout"
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              sparse checkout
            </a>{' '}
            to fetch just that directory.
          </span>
        ) : undefined
      }
    />
  )
}
