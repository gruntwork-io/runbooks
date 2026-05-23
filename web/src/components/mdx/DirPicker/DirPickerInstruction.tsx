import { useMemo, useState, useEffect } from 'react'
import { FolderOpen } from 'lucide-react'
import { InlineMarkdown, BlockIdLabel } from '@/components/mdx/_shared'
import { CompletionCheckbox } from '@/components/mdx/_shared/components/CompletionCheckbox'
import { useBlockCompletion } from '@/components/mdx/_shared/hooks/useBlockCompletion'
import { useRunbookContext, useTemplateContext } from '@/contexts/useRunbook'
import { resolveTemplateReferences } from '@/lib/templateUtils'
import type { DirPickerProps } from './types'

/**
 * Instruction-mode rendering of a DirPicker block (spec §6.4): an instruction to
 * choose a working directory, with a text field. The entered path is published
 * as this block's `PATH` output — exactly the key the interactive DirPicker uses
 * — so downstream commands referencing `{{ .outputs.<id>.PATH }}` resolve from
 * it without a separate manual prompt.
 *
 * Separate component so the interactive path's `useDirPicker` (filesystem
 * browsing IPC) never runs in instruction mode.
 */
export function DirPickerInstruction({
  id,
  title = 'Select Directory',
  description = 'Choose a target directory',
  pathLabel = 'Target Path',
  pathLabelDescription,
  inputsId,
}: DirPickerProps) {
  const { registerOutputs } = useRunbookContext()
  const templateCtx = useTemplateContext(inputsId)

  const resolvedTitle = useMemo(
    () => (title ? resolveTemplateReferences(title, templateCtx) : title),
    [title, templateCtx],
  )
  const resolvedDescription = useMemo(
    () => (description ? resolveTemplateReferences(description, templateCtx) : description),
    [description, templateCtx],
  )
  const resolvedPathLabel = useMemo(
    () => (pathLabel ? resolveTemplateReferences(pathLabel, templateCtx) : pathLabel),
    [pathLabel, templateCtx],
  )
  const resolvedPathLabelDescription = useMemo(
    () =>
      pathLabelDescription
        ? resolveTemplateReferences(pathLabelDescription, templateCtx)
        : pathLabelDescription,
    [pathLabelDescription, templateCtx],
  )

  const [path, setPath] = useState('')

  const { completed, toggle } = useBlockCompletion(id)

  // Publish the chosen path under the same output key the interactive block uses.
  useEffect(() => {
    registerOutputs(id, { PATH: path })
  }, [id, path, registerOutputs])

  return (
    <div
      data-testid={`instruction-${id}`}
      data-instruction-mode="true"
      data-completed={completed || undefined}
      className={`runbook-block relative rounded-sm border mb-5 p-4 ${
        completed ? 'border-success/40 bg-success-muted' : 'border-border bg-muted/40'
      }`}
    >
      <div className="absolute top-3 right-3 z-20">
        <BlockIdLabel id={id} size="large" />
      </div>

      <div className="flex">
        <div className="border-r border-border pr-2 mr-4 flex flex-col items-center">
          <FolderOpen className={`size-6 ${completed ? 'text-success' : 'text-muted-foreground'}`} />
        </div>

        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex justify-end mr-8 -mb-1">
            <CompletionCheckbox completed={completed} onToggle={toggle} />
          </div>
          <div className="text-md font-bold text-foreground">
            <InlineMarkdown>{resolvedTitle}</InlineMarkdown>
          </div>
          <div className="text-md text-muted-foreground mb-3">
            <InlineMarkdown>{resolvedDescription}</InlineMarkdown>
          </div>

          <div>
            <label className="text-sm font-semibold text-foreground mb-0.5 block">
              {resolvedPathLabel}
            </label>
            {resolvedPathLabelDescription && (
              <p className="text-xs text-muted-foreground mb-1.5 m-0">
                <InlineMarkdown>{resolvedPathLabelDescription}</InlineMarkdown>
              </p>
            )}
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="e.g., production/us-east-1/services"
              className="w-full px-3 py-2 text-sm border border-input rounded-md bg-bg-default focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring placeholder:text-muted-foreground font-mono"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
