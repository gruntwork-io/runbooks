import { useEffect, useRef } from "react"
import type { ReactNode } from "react"
import { AlertTriangle, CheckCircle, Loader2, PackageCheck, Square, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  BlockIdLabel,
  InlineMarkdown,
  Instruction,
  RunBlockedWarning,
  ViewLogs,
  ViewOutputs,
} from "@/components/mdx/_shared"
import { CodeBlock } from "@/components/mdx/_shared/components/CodeBlock"
import { DuplicateIdError } from "@/components/mdx/_shared/components/DuplicateIdError"
import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import { AutoCollapse, CollapseButton } from "@/components/mdx/_shared/components/AutoCollapse"
import { ProgressStep } from "@/components/mdx/_shared/components/ProgressStep"
import { useRevealSelf } from "@/components/mdx/_shared/hooks/useRevealSelf"
import { useRunSequencing } from "@/components/mdx/_shared/hooks/useRunSequencing"
import { extractYamlFromChildren } from "@/components/mdx/_shared/lib/extractYamlFromChildren"
import { makeStatusStyles } from "@/components/mdx/_shared/lib/statusStyles"
import type { ExecutionStatus } from "@/components/mdx/_shared/types"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { isRunBlocked } from "@/lib/blockRuns"
import { revealOutputs } from "@/lib/outputValues"
import type { AppError } from "@/types/error"
import {
  TOOL_LIST_FENCE_HINT,
  parsePrerequisitesSpec,
  type PrerequisitesSpec,
} from "../../../../../src/domain/prerequisites/spec"
import { resultsFromOutputs, versionCommand } from "../../../../../src/domain/prerequisites/results"
import { usePrerequisitesRun } from "./hooks/usePrerequisitesRun"
import { ToolList } from "./ToolList"

interface PrerequisitesProps {
  id: string
  title?: string | undefined
  description?: string | undefined
  /** Whether the block folds into a bar with its title once it's done, which expands it again when clicked. */
  autoCollapse?: boolean | undefined
  successMessage?: string | undefined
  warnMessage?: string | undefined
  failMessage?: string | undefined
  runningMessage?: string | undefined
  /** The tool list: a YAML code fence with a `tools:` list. */
  children?: ReactNode
}

const STATUS_STYLES = makeStatusStyles<ExecutionStatus>({
  container: {
    success: "bg-success-muted border-success/30",
    warn: "bg-warning-muted border-warning/30",
    fail: "bg-destructive-muted border-destructive/30",
    running: "bg-info-muted border-info/40",
    pending: "bg-muted border-border",
  },
  icon: {
    success: CheckCircle,
    warn: AlertTriangle,
    fail: XCircle,
    running: Loader2,
    pending: PackageCheck,
  },
  iconColor: {
    success: "text-success",
    warn: "text-warning",
    fail: "text-destructive",
    running: "text-info",
    pending: "text-muted-foreground",
  },
})

// The check reads no outputs.
const NO_OUTPUT_DEPENDENCIES: readonly string[] = []

type ParsedToolList = { ok: true; spec: PrerequisitesSpec } | { ok: false; error: AppError }

/**
 * The block's tool list, from the code fence MDX passes as its children. The
 * test CLI reports the same errors (cli/test/validation.ts).
 */
function parseToolList(id: string, children: ReactNode): ParsedToolList {
  const extracted = children ? extractYamlFromChildren(children) : null
  if (!extracted || extracted.error) {
    return {
      ok: false,
      error: {
        message: `The <Prerequisites id="${id}"> block needs its tool list in a code fence`,
        details: TOOL_LIST_FENCE_HINT,
      },
    }
  }
  const parsed = parsePrerequisitesSpec(extracted.content)
  if (parsed.ok) return parsed
  return {
    ok: false,
    error: {
      message: `The <Prerequisites id="${id}"> tool list is invalid`,
      details: parsed.error,
    },
  }
}

/**
 * Shell commands that show whether each tool is installed, and its version
 * where the block reads it. An `anyOf` list's are joined with `||`, so its
 * line succeeds when any of its tools is installed.
 */
function checkCommands(spec: PrerequisitesSpec): string {
  return spec.requirements
    .map(({ tools }) =>
      tools
        .map((tool) => (tool.versionArgs ? versionCommand(tool) : `command -v ${tool.name}`))
        .join(" || "),
    )
    .join("\n")
}

/**
 * Lists the tools a runbook needs, and checks that each is on PATH at the
 * version the runbook asks for. The check runs in the main process, like a
 * <Check>'s script, since reading a version runs the tool. When a tool is
 * missing, the main process first reads PATH again from the login shell, so a
 * tool installed since Runbooks started is found without restarting it.
 */
function Prerequisites({
  id,
  title,
  description,
  successMessage = "The tools this runbook needs are installed.",
  warnMessage = "The required tools are installed. Some optional ones are missing or out of date.",
  failMessage = "Install or update the tools marked below, then check again.",
  runningMessage = "Checking the tools...",
  children,
  autoCollapse,
}: PrerequisitesProps) {
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(
    id,
    "Prerequisites",
  )
  const { reportError, clearError } = useErrorReporting()
  const { enabled: instructionMode } = useInstructionMode()
  const toolList = parseToolList(id, children)
  const { state, check, cancel, error } = usePrerequisitesRun(id)
  const status: ExecutionStatus = state.status

  const blockRef = useRef<HTMLDivElement>(null)
  const revealSelf = useRevealSelf(blockRef)
  const { blockers, stopRun, revealBlock } = useRunSequencing({
    blockId: id,
    status,
    exclusive: false,
    dependsOn: undefined,
    outputDependencyIds: NO_OUTPUT_DEPENDENCIES,
    stop: cancel,
    reveal: revealSelf,
  })

  const configError = toolList.ok ? null : toolList.error.message
  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: "Prerequisites",
        severity: "error",
        message: `Duplicate component ID: ${id}`,
      })
    } else if (configError) {
      reportError({
        componentId: id,
        componentType: "Prerequisites",
        severity: "error",
        message: configError,
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, configError, reportError, clearError])

  if (!id) {
    return (
      <ErrorDisplay
        error={{
          message: "The <Prerequisites> component requires a non-empty 'id' prop.",
          details: "Please provide a unique 'id' for this component instance.",
        }}
      />
    )
  }
  if (isDuplicate) {
    return (
      <DuplicateIdError
        id={id}
        isNormalizedCollision={isNormalizedCollision}
        collidingId={collidingId}
        componentName="Prerequisites"
        showUniquenessHint
      />
    )
  }
  if (!toolList.ok) return <ErrorDisplay error={toolList.error} />
  const { spec } = toolList

  // Instruction mode lists the tools, with every install hint, and the
  // commands that check them. Nothing runs.
  if (instructionMode) {
    return (
      <Instruction
        id={id}
        icon={PackageCheck}
        title={title ?? "Make sure these tools are installed:"}
        description={description}
        autoCollapse={autoCollapse}
        note={
          <div className="space-y-3">
            <ToolList requirements={spec.requirements} results={[]} showAllInstallHints />
            <div>To check them, run:</div>
            <CodeBlock>
              <code className="language-bash whitespace-pre-wrap">{checkCommands(spec)}</code>
            </CodeBlock>
          </div>
        }
      />
    )
  }

  // The outputs say what the check found: each tool's path, and the versions it read.
  const results = state.outputs ? resultsFromOutputs(spec, revealOutputs(state.outputs)) : []
  const finished = status === "success" || status === "warn" || status === "fail"
  const message = {
    success: { text: successMessage, className: "text-success" },
    warn: { text: warnMessage, className: "text-warning" },
    fail: { text: failMessage, className: "text-destructive" },
    running: { text: runningMessage, className: "text-info" },
    pending: null,
  }[status]

  // A warning means only optional tools are missing
  const done = status === "success" || status === "warn"
  return (
    <AutoCollapse enabled={autoCollapse} done={done}>
      <div
        data-fold="path"
        ref={blockRef}
        data-testid={id}
        className={`runbook-block relative rounded-sm border ${STATUS_STYLES.getStatusClasses(status)} mb-5 p-4`}
      >
        <ProgressStep done={done} />

        <div data-fold="keep" className="absolute top-3 right-3 z-20 flex items-center gap-1">
          <BlockIdLabel id={id} size="large" />
          <CollapseButton />
        </div>

        <div data-fold="path" className="flex @container">
          <div
            data-fold="keep"
            className="border-r border-border pr-2 mr-4 flex flex-col items-center"
          >
            <STATUS_STYLES.StatusIcon
              status={status}
              data-testid={`icon-${status}`}
              className={`size-6 ${STATUS_STYLES.getStatusIconClasses(status)} ${status === "running" ? "animate-spin" : ""}`}
            />
          </div>

          <div data-fold="path" className="flex-1 min-w-0 space-y-2">
            <div data-fold="title" className="text-md font-bold text-muted-foreground mr-12">
              <InlineMarkdown>{title ?? "Tools this runbook needs"}</InlineMarkdown>
            </div>
            {description && (
              <div className="text-md text-muted-foreground mb-3">
                <InlineMarkdown>{description}</InlineMarkdown>
              </div>
            )}
            {message?.text && (
              <div className={`${message.className} font-semibold text-sm mb-3`}>
                <InlineMarkdown>{message.text}</InlineMarkdown>
              </div>
            )}

            <ToolList requirements={spec.requirements} results={results} />

            <div className="border-b border-border"></div>

            <RunBlockedWarning
              blockType="check"
              exclusive={false}
              blockers={blockers}
              onStop={stopRun}
              onReveal={revealBlock}
            />

            {error && (
              <div className="mb-3 text-sm text-destructive flex items-start gap-2">
                <XCircle className="size-4 mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <strong>{error.message}</strong>
                  {error.details && (
                    <div className="text-xs mt-1 text-destructive">{error.details}</div>
                  )}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={status === "running" || isRunBlocked(blockers)}
                onClick={check}
              >
                {finished ? "Check again" : "Check"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => cancel()}
                disabled={status !== "running"}
                className="text-destructive hover:text-destructive hover:bg-destructive-muted disabled:text-muted-foreground disabled:hover:bg-transparent"
              >
                <Square className="size-4 mr-1" />
                Stop
              </Button>
            </div>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <ViewLogs
            logs={state.logs}
            status={status}
            autoOpen={status === "running"}
            blockId={id}
            logFilePath={state.logFilePath}
          />
          {/* What other blocks can read: a failed check publishes nothing. */}
          <ViewOutputs outputs={status === "fail" ? null : state.outputs} autoOpen={false} />
        </div>
      </div>
    </AutoCollapse>
  )
}

// Set displayName for React DevTools and component detection
Prerequisites.displayName = "Prerequisites"

export default Prerequisites
