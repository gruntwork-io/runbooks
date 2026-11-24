import type { ReactNode } from "react"
import { ListChecks, AlertTriangle, type LucideIcon } from "lucide-react"
import { CodeBlock } from "./CodeBlock"
import { ViewSourceCode } from "./ViewSourceCode"
import { InlineMarkdown } from "./InlineMarkdown"
import { BlockIdLabel } from "./BlockIdLabel"
import { AutoCollapse, CollapseButton } from "./AutoCollapse"
import { CompletionCheckbox } from "./CompletionCheckbox"
import { useInstructionResolution } from "../hooks/useInstructionResolution"
import { useBlockCompletion } from "../hooks/useBlockCompletion"
import { normalizeCommandList } from "../lib/instructionResolution"
import type { TemplateContext } from "@/lib/templateUtils"
import { exportLines, shellQuote } from "../../../../../../src/domain/exec/blockEnv.ts"

/** A file-backed script to display via the collapsible source viewer, as written. */
export interface InstructionSource {
  content: string
  path?: string | undefined
  language?: string | undefined
  fileName?: string | undefined
}

export interface InstructionProps {
  /** Short imperative heading, e.g. "Run this:" or "Log into AWS". */
  title: string
  /** Optional prose under the title (markdown). */
  description?: string | undefined
  /**
   * Command(s) a block builds, to display as copyable code. Their `{{ … }}`
   * references are resolved.
   */
  command?: string | string[] | undefined
  /** A script block's inline script, shown as copyable code as written. */
  script?: string | undefined
  /** A file-backed script to show via the source viewer instead of a command. */
  source?: InstructionSource | undefined
  /** Template context (Inputs-form values) used to resolve the command, env and workingDir. */
  templateContext?: TemplateContext | undefined
  /**
   * Env vars the command or script needs, as templates by name (a script
   * block's `env` prop). They're resolved like the command and shown as
   * `export` lines before it, so one copy sets them and runs it.
   */
  env?: Readonly<Record<string, string>> | undefined
  /**
   * The directory the command or script runs in, as a template (a script
   * block's `workingDir` prop). It's resolved like the command and shown as a
   * `cd` line before it.
   */
  workingDir?: string | undefined
  /**
   * The program that runs the command or script (a script block's
   * `interpreter` prop). The reader is told to run it with that program, and
   * the shell setup lines get a block of their own, since they're not in the
   * program's language.
   */
  interpreter?: string | undefined
  /**
   * An embedded form shown before the command — e.g. a Command's nested
   * `<Inputs>`. Its values reach `templateContext`, so the command updates as
   * the user fills it in.
   */
  inputs?: ReactNode
  /** Extra prose/notes shown after the command (e.g. sparse-checkout note). */
  note?: ReactNode
  /** Icon shown in the heading. Defaults to a checklist glyph. */
  icon?: LucideIcon | undefined
  /** Block id — surfaces the ID label and a stable test id. */
  id?: string | undefined
  /**
   * Called when the user marks the block done (not when they un-mark it, and
   * not for a done state restored on load). <Finish> celebrates with it.
   */
  onMarkedDone?: (() => void) | undefined
  /** The block's `autoCollapse` prop: once marked done, it folds down to its title. */
  autoCollapse?: boolean | undefined
}

const EMPTY_CONTEXT: TemplateContext = { inputs: {}, outputs: {} }
const NO_ENV: Readonly<Record<string, string>> = {}

/**
 * Shared presentation primitive for instruction mode (spec §6.3). Renders a
 * flattened, copy-pasteable instruction: heading + prose + any embedded Inputs
 * form + the resolved command (or a source viewer for file-backed scripts) +
 * any auto-detected manual-input fields for `{{ .outputs.* }}` values the user
 * must supply.
 *
 * Resolution lives here (via useInstructionResolution) so a block converts to
 * instruction mode with a single declarative early-return and no extra hooks of
 * its own.
 */
export function Instruction({
  title,
  description,
  command,
  script,
  source,
  templateContext = EMPTY_CONTEXT,
  env = NO_ENV,
  workingDir,
  interpreter,
  inputs,
  note,
  icon: Icon = ListChecks,
  id,
  onMarkedDone,
  autoCollapse,
}: InstructionProps) {
  const commandList = normalizeCommandList(command)
  const envNames = Object.keys(env)
  // Resolve the commands, the env and the working dir in a single pass so
  // manual fields are detected across all of them and we make at most one
  // render call. A script and a source show as written.
  const allTexts = [
    ...commandList,
    ...envNames.map((name) => env[name]!),
    ...(workingDir ? [workingDir] : []),
  ]
  const { resolvedCommands, manualFields, usedFallback } = useInstructionResolution({
    command: allTexts,
    templateContext,
  })

  const resolvedCmds = [
    ...resolvedCommands.slice(0, commandList.length),
    ...(script !== undefined ? [script] : []),
  ]
  const envStart = commandList.length
  const exports = exportLines(
    Object.fromEntries(envNames.map((name, i) => [name, resolvedCommands[envStart + i] ?? ""])),
  )
  const resolvedWorkingDir = workingDir ? resolvedCommands[envStart + envNames.length] : undefined
  // In a terminal RUNBOOK_ENV is unset, and appending to "$RUNBOOK_ENV" fails
  const writesRunbookEnv = [...commandList, script ?? "", source?.content ?? ""].some((text) =>
    text.includes("RUNBOOK_ENV"),
  )
  const setup = [
    ...(writesRunbookEnv ? ["export RUNBOOK_ENV=/dev/null"] : []),
    ...(resolvedWorkingDir ? [`cd ${shellQuote(resolvedWorkingDir)}`] : []),
    ...(exports ? [exports] : []),
  ].join("\n")
  // The setup goes in the first command's block, or in a block of its own
  // before a script's source or a command another program runs
  const setupApart = !!setup && (resolvedCmds.length === 0 || !!interpreter)
  const shownCmds =
    setup && !setupApart ? [`${setup}\n${resolvedCmds[0]}`, ...resolvedCmds.slice(1)] : resolvedCmds

  const { completed, toggle } = useBlockCompletion(id ?? "")
  // Called here, not inside toggle's state updater, which StrictMode runs twice.
  const handleToggle = () => {
    if (!completed) onMarkedDone?.()
    toggle()
  }

  return (
    <AutoCollapse enabled={autoCollapse} done={!!id && completed}>
      <div
        data-fold="path"
        data-testid={id ? `instruction-${id}` : "instruction"}
        data-instruction-mode="true"
        data-completed={completed || undefined}
        className={`runbook-block relative rounded-sm border mb-5 p-4 ${
          completed ? "border-success/40 bg-success-muted" : "border-border bg-muted/40"
        }`}
      >
        {id && (
          <div data-fold="keep" className="absolute top-3 right-3 z-20 flex items-center gap-1">
            <BlockIdLabel id={id} size="large" />
            <CollapseButton />
          </div>
        )}

        <div data-fold="path" className="flex">
          <div
            data-fold="keep"
            className="border-r border-border pr-2 mr-4 flex flex-col items-center"
          >
            <Icon className={`size-6 ${completed ? "text-success" : "text-muted-foreground"}`} />
          </div>

          <div data-fold="path" className="flex-1 min-w-0 space-y-3">
            {id && (
              // Clear of the ID label, and the collapse button beside it
              <div
                data-fold="keep"
                className={`flex justify-end -mb-1 ${autoCollapse ? "mr-14" : "mr-8"}`}
              >
                <CompletionCheckbox completed={completed} onToggle={handleToggle} />
              </div>
            )}
            <div data-fold="title" className="text-md font-bold text-foreground">
              <InlineMarkdown>{title}</InlineMarkdown>
            </div>
            {description && (
              <div className="text-md text-muted-foreground">
                <InlineMarkdown>{description}</InlineMarkdown>
              </div>
            )}

            {/* Embedded Inputs form, placed before the command (as in the
              interactive layout) so the command updates as the user fills it. */}
            {inputs && <div>{inputs}</div>}

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

            {/* The setup (working dir, env vars), in a shell, before the script. */}
            {setupApart && (
              <CodeBlock>
                <code className="language-bash whitespace-pre-wrap">{setup}</code>
              </CodeBlock>
            )}

            {interpreter && (
              <div
                data-testid={id ? `instruction-${id}-interpreter` : undefined}
                className="text-sm text-muted-foreground"
              >
                Run this with <span className="font-mono text-foreground">{interpreter}</span>:
              </div>
            )}

            {/* Resolved command(s) as copyable code blocks. */}
            {shownCmds.map((cmd, i) => (
              <CodeBlock key={i}>
                <code className={`${interpreter ? "" : "language-bash "}whitespace-pre-wrap`}>
                  {cmd}
                </code>
              </CodeBlock>
            ))}

            {writesRunbookEnv && (
              <div
                data-testid={id ? `instruction-${id}-runbook-env` : undefined}
                className="flex items-start gap-1.5 text-xs text-muted-foreground"
              >
                <AlertTriangle className="size-3.5 mt-0.5 flex-shrink-0 text-warning" />
                <span>
                  This step saves variables for later steps in{" "}
                  <span className="font-mono">$RUNBOOK_ENV</span>. Your terminal discards them, so
                  set the ones later steps need in your shell yourself.
                </span>
              </div>
            )}

            {note && <div className="text-sm text-muted-foreground">{note}</div>}

            {usedFallback && (
              <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <AlertTriangle className="size-3.5 mt-0.5 flex-shrink-0 text-warning" />
                <span>
                  Shown using a simplified resolver — template logic (conditionals, functions) may
                  not be fully evaluated.
                </span>
              </div>
            )}

            {/* File-backed scripts keep the source viewer (PRD §5). */}
            {source && (
              <ViewSourceCode
                sourceCode={source.content}
                path={source?.path}
                language={source?.language}
                fileName={source?.fileName ?? "Script"}
              />
            )}
          </div>
        </div>
      </div>
    </AutoCollapse>
  )
}

Instruction.displayName = "Instruction"
