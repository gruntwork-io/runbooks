import type { ReactNode } from 'react'
import { ListChecks, AlertTriangle, type LucideIcon } from 'lucide-react'
import { CodeBlock } from './CodeBlock'
import { ViewSourceCode } from './ViewSourceCode'
import { InlineMarkdown } from './InlineMarkdown'
import { BlockIdLabel } from './BlockIdLabel'
import { CompletionCheckbox } from './CompletionCheckbox'
import { useInstructionResolution } from '../hooks/useInstructionResolution'
import { useBlockCompletion } from '../hooks/useBlockCompletion'
import { normalizeCommandList } from '../lib/instructionResolution'
import type { TemplateContext } from '@/lib/templateUtils'

/** A file-backed script to display via the collapsible source viewer. */
export interface InstructionSource {
  /** Raw source content (may contain `{{ … }}`; it is resolved before display). */
  content: string
  path?: string
  language?: string
  fileName?: string
}

export interface InstructionProps {
  /** Short imperative heading, e.g. "Run this:" or "Log into AWS". */
  title: string
  /** Optional prose under the title (markdown). */
  description?: string
  /** Raw command(s) to display as copyable code (with `{{ … }}` intact). */
  command?: string | string[]
  /** A file-backed script to show via the source viewer instead of a command. */
  source?: InstructionSource
  /** Template context (Inputs-form values) used to resolve the command/source. */
  templateContext?: TemplateContext
  /** Extra prose/notes shown after the command (e.g. sparse-checkout note). */
  note?: ReactNode
  /** Icon shown in the heading. Defaults to a checklist glyph. */
  icon?: LucideIcon
  /** Block id — surfaces the ID label and a stable test id. */
  id?: string
}

const EMPTY_CONTEXT: TemplateContext = { inputs: {}, outputs: {} }

/**
 * Shared presentation primitive for instruction mode (spec §6.3). Renders a
 * flattened, copy-pasteable instruction: heading + prose + the resolved
 * command (or a source viewer for file-backed scripts) + any auto-detected
 * manual-input fields for `{{ .outputs.* }}` values the user must supply.
 *
 * Resolution lives here (via useInstructionResolution) so a block converts to
 * instruction mode with a single declarative early-return and no extra hooks of
 * its own.
 */
export function Instruction({
  title,
  description,
  command,
  source,
  templateContext = EMPTY_CONTEXT,
  note,
  icon: Icon = ListChecks,
  id,
}: InstructionProps) {
  const commandList = normalizeCommandList(command)
  // Resolve commands and the source content in a single pass so manual fields
  // are detected across both and we make at most one render call.
  const allTexts = source ? [...commandList, source.content] : commandList
  const { resolvedCommands, manualFields, usedFallback } = useInstructionResolution({
    command: allTexts,
    templateContext,
  })

  const resolvedCmds = resolvedCommands.slice(0, commandList.length)
  const resolvedSource = source ? resolvedCommands[commandList.length] : undefined

  const { completed, toggle } = useBlockCompletion(id ?? '')

  return (
    <div
      data-testid={id ? `instruction-${id}` : 'instruction'}
      data-instruction-mode="true"
      data-completed={completed || undefined}
      className={`runbook-block relative rounded-sm border mb-5 p-4 ${
        completed ? 'border-success/40 bg-success-muted' : 'border-border bg-muted/40'
      }`}
    >
      {id && (
        <div className="absolute top-3 right-3 z-20">
          <BlockIdLabel id={id} size="large" />
        </div>
      )}

      <div className="flex">
        <div className="border-r border-border pr-2 mr-4 flex flex-col items-center">
          <Icon className={`size-6 ${completed ? 'text-success' : 'text-muted-foreground'}`} />
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          {id && (
            <div className="flex justify-end mr-8 -mb-1">
              <CompletionCheckbox completed={completed} onToggle={toggle} />
            </div>
          )}
          <div className="text-md font-bold text-foreground">
            <InlineMarkdown>{title}</InlineMarkdown>
          </div>
          {description && (
            <div className="text-md text-muted-foreground">
              <InlineMarkdown>{description}</InlineMarkdown>
            </div>
          )}

          {/* Manual-input fields for output-derived values (§6.5.2). Placed
              before the command so the command updates as the user fills them. */}
          {manualFields.length > 0 && (
            <div className="space-y-2">
              {manualFields.map((field) => (
                <label key={field.id} className="block text-sm">
                  <span className="text-muted-foreground">{field.label}</span>
                  <input
                    type="text"
                    value={field.value}
                    onChange={(e) => field.onChange(e.target.value)}
                    placeholder={`Paste the ${field.outputName} value`}
                    className="mt-1 w-full rounded-sm border border-border bg-bg-default px-2 py-1 font-mono text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </label>
              ))}
            </div>
          )}

          {/* Resolved command(s) as copyable code blocks. */}
          {resolvedCmds.map((cmd, i) => (
            <CodeBlock key={i}>
              <code className="language-bash whitespace-pre-wrap">{cmd}</code>
            </CodeBlock>
          ))}

          {note && <div className="text-sm text-muted-foreground">{note}</div>}

          {usedFallback && (
            <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <AlertTriangle className="size-3.5 mt-0.5 flex-shrink-0 text-warning" />
              <span>
                Shown using a simplified resolver — template logic
                (conditionals, functions) may not be fully evaluated.
              </span>
            </div>
          )}

          {/* File-backed scripts keep the source viewer (PRD §5). */}
          {resolvedSource !== undefined && (
            <ViewSourceCode
              sourceCode={resolvedSource}
              path={source?.path}
              language={source?.language}
              fileName={source?.fileName ?? 'Script'}
            />
          )}
        </div>
      </div>
    </div>
  )
}

Instruction.displayName = 'Instruction'
