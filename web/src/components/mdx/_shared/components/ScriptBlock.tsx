import { XCircle, Square, AlertTriangle } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { Admonition } from "@/components/mdx/Admonition"
import { useState, useMemo, cloneElement, isValidElement, useRef, useEffect } from "react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import {
  ViewSourceCode,
  ViewLogs,
  ViewOutputs,
  useScriptExecution,
  InlineMarkdown,
  UnmetDependenciesWarning,
  UnmetSignInWarning,
  RunBlockedWarning,
  BlockIdLabel,
  Instruction,
} from "@/components/mdx/_shared"
import { AutoCollapse, CollapseButton, WhenFolded } from "./AutoCollapse"
import { DuplicateIdError } from "./DuplicateIdError"
import { EnvVars } from "./EnvVars"
import { ProgressStep } from "./ProgressStep"
import { ScriptChangeNotice } from "./ScriptChangeNotice"
import { useRunSequencing } from "../hooks/useRunSequencing"
import { isRunBlocked } from "@/lib/blockRuns"
import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { issueAnchor } from "@/contexts/ErrorReportingContext.types"
import { useSessionHistory } from "@/contexts/useSessionHistory"
import { runEnded } from "@/lib/sessionHistory"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import type { AppError } from "@/types/error"
import type { ComponentType, ExecutionStatus } from "../types"
import type { StatusStyles } from "../lib/statusStyles"
import { replacedAuthPropError } from "../../../../../../src/domain/exec/blockEnv.ts"

/**
 * The per-block configuration that distinguishes <Command>, <Check> and <Finish>.
 * Everything else (execution wiring, dependency/auth warnings, drift handling,
 * logs/outputs/source viewers, error states) is shared by ScriptBlock below.
 */
export interface ScriptBlockVariant {
  /** componentType forwarded to useScriptExecution. */
  componentType: ComponentType
  /** Registry/error-reporting name and the `<Name>` shown in messages. */
  name: "Command" | "Check" | "Finish"
  /** Primary action button label. */
  runLabel: string
  /** runningMessage used when the author doesn't provide one. */
  defaultRunningMessage: string
  /** fileName shown in the instruction source + ViewSourceCode viewers. */
  fileName: string
  /** Heading in the file-load error block. */
  fileErrorHeading: string
  /** Noun in the "Configuration Required" message ("command" / "check script"). */
  missingInputsSubject: string
  /** Show the file-script metadata block + "View Source Code" button (Command only). */
  showScriptMetadata: boolean
  /** Show the pending "Run a command/script" placeholder (Command only). */
  showPendingPlaceholder: boolean
  /** Optional icon for instruction-mode flattening (Check uses CircleQuestionMark). */
  instructionIcon?: LucideIcon
  /** Instruction-mode title for inline commands. */
  instructionInlineTitle: string
  /** Instruction-mode title for path-based scripts. */
  instructionPathTitle: string
  /** status → container / icon / icon-color accessors. */
  statusStyles: StatusStyles<ExecutionStatus>
  /**
   * The script is optional (Finish only). With neither `command` nor `path`,
   * the Run button completes the block in the renderer without running
   * anything, and there are no logs or Stop button.
   */
  scriptOptional?: boolean
  /** Whether a nested <Inputs> child can supply the script's values. Defaults to true. */
  inlineInputs?: boolean
  /**
   * Whether a warning (exit code 2) leaves the block done in the runbook's
   * progress, as it lets a block that `dependsOn` it run. Defaults to true;
   * a Finish whose final check warns hasn't finished.
   */
  warnIsDone?: boolean
}

export interface ScriptBlockProps {
  id: string
  title?: string | undefined
  description?: string | undefined
  path?: string | undefined
  command?: string | undefined
  /** Reference to one or more Inputs by ID for template variable substitution. When multiple IDs are provided, variables are merged in order (later IDs override earlier ones). */
  inputsId?: string | string[] | undefined
  /** Environment variables the script runs with, by name. Each value is a template, rendered with the same inputs and outputs as the script, and reaches the script as data: `env={{ BUCKET: "{{ .inputs.BucketName }}" }}` with `"$BUCKET"` in the script. They're set for this run only. */
  env?: Readonly<Record<string, string | number | boolean>> | undefined
  /** The directory the script runs in: absolute, or relative to the session's directory. It may use templates, rendered with the same inputs and outputs as the script. Defaults to the session's directory. */
  workingDir?: string | undefined
  /** The program, with optional args, that runs the script when it has no shebang, such as `interpreter="python3"`. A script with a shebang can't also set it. Defaults to the program for the script file's extension, or bash. */
  interpreter?: string | undefined
  /** The ids of the auth blocks whose sign-in the script runs with, such as `envFrom={["aws_prod"]}`. Each block's variables apply in order, a later block's over an earlier one's, then `env` applies over all of them. Run waits until each block has signed in. */
  envFrom?: readonly string[] | undefined
  successMessage?: string | undefined
  /** Warning message (Check only — Command never reaches the warn state). */
  warnMessage?: string | undefined
  failMessage?: string | undefined
  runningMessage?: string | undefined
  children?: ReactNode // For inline Inputs component
  /** Whether to use PTY (pseudo-terminal) for script execution. Defaults to true. Set to false to use pipes instead, which may be needed for scripts that don't work well with PTY or when simpler output handling is preferred. */
  usePty?: boolean | undefined
  /** Per-execution timeout in milliseconds. When omitted, the executor's default timeout (60 minutes) applies. */
  timeoutMs?: number | undefined
  /** IDs of Command or Check blocks that must have run successfully, and not be running, before this block can run. */
  dependsOn?: string | string[] | undefined
  /** Whether this block must run alone. While it runs no other Command or Check block can start, and it can't start while another one is running. */
  exclusive?: boolean | undefined
  /** Shown inside the block once it succeeds (Finish's next steps). In instruction mode it is always shown. */
  successContent?: ReactNode
  /** Called each time the block goes to success (never on mount), or is marked done in instruction mode. */
  onComplete?: (() => void) | undefined
  /** Whether the block folds into a bar with its title once it's done, which expands it again when clicked. */
  autoCollapse?: boolean | undefined
  /** Distinguishes the Command, Check and Finish presentation. */
  variant: ScriptBlockVariant
}

/**
 * Shared implementation behind the <Command>, <Check> and <Finish> MDX blocks.
 * They differ only in the `variant` config (labels, status styling, instruction
 * wording, a couple of Command-only UI affordances, and Finish's optional
 * script) and Finish's successContent/onComplete; all execution, dependency,
 * and error-handling behavior is identical.
 */
export function ScriptBlock({
  id,
  title,
  description,
  path,
  command,
  inputsId,
  env,
  workingDir,
  interpreter: interpreterProp,
  envFrom: envFromProp,
  successMessage = "Success",
  warnMessage = "Warning",
  failMessage = "Failed",
  runningMessage,
  children,
  usePty,
  timeoutMs,
  dependsOn,
  exclusive = false,
  successContent,
  onComplete,
  autoCollapse,
  variant,
  // Props a runbook sets that ScriptBlockProps doesn't have, such as awsAuthId
  ...otherProps
}: ScriptBlockProps) {
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: `The <${variant.name}> component requires a non-empty 'id' prop.`,
        details: "Please provide a unique 'id' for this component instance.",
      }
    }
    return null
  }, [id, variant.name])

  // Check for duplicate component IDs (including normalized collisions like "a-b" vs "a_b")
  const blockRef = useRef<HTMLDivElement>(null)
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(
    id,
    variant.name,
    blockRef,
  )

  const { reportError, clearError } = useErrorReporting()

  // Instruction mode flattens this block into a copy-pasteable instruction.
  const { enabled: instructionMode } = useInstructionMode()

  const {
    rawScriptContent,
    language,
    fileError: getFileError,
    envTemplates,
    envVars,
    envError,
    envFrom,
    envFromError,
    unsignedEnvFrom,
    workingDirTemplate,
    workingDirError,
    interpreter,
    interpreterError,
    overrideOutput,
    resetOutputOverride,
    inputDependencies,
    unmetInputDependencies,
    hasAllInputDependencies,
    inlineInputsId,
    outputDependencyBlockIds,
    unmetOutputDependencies,
    hasAllOutputDependencies,
    isRendering,
    renderError,
    templateContext,
    status: execStatus,
    logs,
    logFilePath,
    execError,
    execute: handleExecute,
    cancel,
    outputs,
    hasScriptDrift,
    scriptFileChange,
    reloadScript,
    isReloadingScript,
    scriptReloadError,
  } = useScriptExecution({
    componentId: id,
    path,
    command,
    inputsId,
    children,
    componentType: variant.componentType,
    usePty,
    timeoutMs,
    env,
    envFrom: envFromProp,
    workingDir,
    interpreter: interpreterProp,
  })

  // With no script to run (a <Finish> without a final check), the Run button
  // completes the block right here: nothing reaches IPC. The session's history
  // keeps that as a run that succeeded, which useScriptExecution restores like
  // any other run, so the block starts completed when the session resumes.
  const history = useSessionHistory()
  const scriptless = !!variant.scriptOptional && !command && !path
  const [scriptlessDone, setScriptlessDone] = useState(execStatus === "success")
  const completeScriptless = () => {
    setScriptlessDone(true)
    history.record(
      id,
      "run",
      runEnded({
        logs: [],
        status: "success",
        exitCode: null,
        error: null,
        outputs: null,
        logFilePath: null,
      }),
    )
  }
  const status: ExecutionStatus = scriptless ? (scriptlessDone ? "success" : "pending") : execStatus
  const done = status === "success" || (status === "warn" && variant.warnIsDone !== false)

  // Call onComplete on each transition into success: a first run or a re-run,
  // but never a block that mounts already succeeded.
  const prevStatusRef = useRef(status)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    if (status === "success" && prev !== "success") onComplete?.()
  }, [status, onComplete])

  const { blockers: runBlockers, stopRun } = useRunSequencing({
    blockId: id,
    status,
    exclusive,
    dependsOn,
    outputDependencyIds: outputDependencyBlockIds,
    stop: cancel,
  })

  // Clone children and add variant="embedded" prop if it's an Inputs component
  const childrenWithVariant = useMemo(() => {
    if (!children) return null

    // If children is a valid React element, clone it with variant prop
    if (isValidElement(children)) {
      return cloneElement(children, { variant: "embedded" } as Record<string, unknown>)
    }

    return children
  }, [children])

  // State for controlling ViewSourceCode
  const [showSourceCode, setShowSourceCode] = useState(false)

  // Ref for scrolling to ViewSourceCode section
  const viewSourceCodeRef = useRef<HTMLDivElement>(null)

  // Determine if we should display the command inline
  const displayCommand = useMemo(() => {
    // Don't display if using path (ViewSourceCode handles it)
    if (path) return null

    // Display inline command if present
    if (command) {
      const isMultiLine = command.includes("\n")
      return { content: rawScriptContent, isMultiLine }
    }

    return null
  }, [path, command, rawScriptContent])

  // Calculate script metadata for file-based scripts (Command only)
  const scriptMetadata = useMemo(() => {
    if (!path || command) return null

    const lines = rawScriptContent.split("\n").length
    const languageDisplay = language || "shell"

    return { lines, language: languageDisplay }
  }, [path, command, rawScriptContent, language])

  // Resolve display string props using template context
  const resolvedTitle = useMemo(
    () => (title ? resolveTemplateReferences(title, templateContext) : title),
    [title, templateContext],
  )
  const resolvedDescription = useMemo(
    () => (description ? resolveTemplateReferences(description, templateContext) : description),
    [description, templateContext],
  )
  const resolvedSuccessMessage = useMemo(
    () => resolveTemplateReferences(successMessage, templateContext),
    [successMessage, templateContext],
  )
  const resolvedWarnMessage = useMemo(
    () => resolveTemplateReferences(warnMessage, templateContext),
    [warnMessage, templateContext],
  )
  const resolvedFailMessage = useMemo(
    () => resolveTemplateReferences(failMessage, templateContext),
    [failMessage, templateContext],
  )
  const resolvedRunningMessage = useMemo(
    () =>
      resolveTemplateReferences(runningMessage ?? variant.defaultRunningMessage, templateContext),
    [runningMessage, variant.defaultRunningMessage, templateContext],
  )

  // The ID label is pinned to the block's top-right corner. Without a title
  // row beside it, the full-width command box (or, with `path`, the separator)
  // can be the first row: a pending Check has no placeholder line. Keep both
  // clear of the label, as the drift Admonition does. Keyed on the title alone
  // so the width stays put as status lines come and go.
  const clearIdLabel = resolvedTitle ? "" : "mr-12"

  // Check if component requires variables but none are configured. Only Inputs
  // blocks supply `.inputs` values; an auth block reference never does.
  const missingInputsConfig = inputDependencies.length > 0 && !inputsId && !inlineInputsId

  const propError =
    replacedAuthPropError(otherProps) ??
    envError ??
    envFromError ??
    workingDirError ??
    interpreterError

  // Report errors to the error reporting context
  useEffect(() => {
    // Determine if there's an error to report
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: variant.name,
        severity: "error",
        message: `Duplicate component ID: ${id}`,
      })
    } else if (getFileError) {
      reportError({
        componentId: id,
        componentType: variant.name,
        severity: "error",
        message: getFileError.message,
      })
    } else if (propError) {
      reportError({
        componentId: id,
        componentType: variant.name,
        severity: "error",
        message: propError,
      })
    } else if (missingInputsConfig) {
      reportError({
        componentId: id,
        componentType: variant.name,
        severity: "warning",
        message: `Missing Inputs configuration for variables: ${inputDependencies.join(", ")}`,
      })
    } else {
      // No error, clear any previously reported error
      clearError(id)
    }
  }, [
    id,
    isDuplicate,
    getFileError,
    propError,
    missingInputsConfig,
    inputDependencies,
    reportError,
    clearError,
    variant.name,
  ])

  const statusClasses = variant.statusStyles.getStatusClasses(status)
  const iconClasses = variant.statusStyles.getStatusIconClasses(status)

  // Early return for validation errors (e.g. missing id prop)
  if (validationError) {
    return <ErrorDisplay error={validationError} />
  }

  // Early return for duplicate ID error
  if (isDuplicate) {
    return (
      <DuplicateIdError
        id={id}
        isNormalizedCollision={isNormalizedCollision}
        collidingId={collidingId}
        componentName={variant.name}
        showUniquenessHint
      />
    )
  }

  // Early return for file errors - show only error message
  if (getFileError) {
    return (
      <div
        {...issueAnchor(id)}
        className="relative rounded-sm border bg-destructive-muted border-destructive/30 mb-5 p-4"
      >
        <div className="flex items-center text-destructive">
          <XCircle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            <strong>{variant.fileErrorHeading}:</strong>
            <br />
            {getFileError.message}
            {path && (
              <span>
                . Failed to load file at {path}. Does the file exist? Do you have permission to read
                it?
              </span>
            )}
          </div>
        </div>
      </div>
    )
  }

  // An env, workingDir or interpreter prop that isn't valid registers no script, so the block can't run
  if (propError) {
    return (
      <div
        {...issueAnchor(id)}
        className="relative rounded-sm border bg-destructive-muted border-destructive/30 mb-5 p-4"
      >
        <div className="flex items-center text-destructive">
          <XCircle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            <strong>{variant.fileErrorHeading}:</strong>
            <br />
            {propError}
          </div>
        </div>
      </div>
    )
  }

  // Check if command/script requires variables but none are configured
  if (missingInputsConfig) {
    return (
      <div
        {...issueAnchor(id)}
        className="relative rounded-sm border bg-warning-muted border-warning/30 mb-5 p-4"
      >
        <div className="flex items-center text-warning-foreground">
          <AlertTriangle className="size-6 mr-4 flex-shrink-0" />
          <div className="text-md">
            <strong>Configuration Required:</strong>
            <br />
            This {variant.missingInputsSubject} requires variables ({inputDependencies.join(", ")})
            but no Inputs component is configured.{" "}
            {variant.inlineInputs === false ? (
              <>
                Please add an <code className="bg-warning-muted px-1 rounded">inputsId</code> prop
                referencing an existing Inputs block.
              </>
            ) : (
              <>
                Please add either:
                <ul className="list-disc ml-6 mt-2">
                  <li>
                    An inline <code className="bg-warning-muted px-1 rounded">{"<Inputs>"}</code>{" "}
                    component as a child
                  </li>
                  <li>
                    An <code className="bg-warning-muted px-1 rounded">inputsId</code> prop
                    referencing an existing Inputs
                  </li>
                </ul>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  // Instruction mode: flatten to a copy-pasteable instruction. Nothing runs —
  // no exec:run, no logs/outputs, no disabled Run button (spec §6.4). Resolve
  // from the raw script content so it works regardless of dependency state.
  // A nested <Inputs> stays a form: it is how the user supplies the values
  // the env and working directory lines show.
  if (instructionMode) {
    return (
      <Instruction
        id={id}
        icon={variant.instructionIcon}
        title={
          resolvedTitle || (path ? variant.instructionPathTitle : variant.instructionInlineTitle)
        }
        description={resolvedDescription}
        script={scriptless || path ? undefined : rawScriptContent}
        source={
          path
            ? { content: rawScriptContent, path, language, fileName: variant.fileName }
            : undefined
        }
        templateContext={templateContext}
        env={scriptless ? undefined : envTemplates}
        workingDir={scriptless ? undefined : workingDirTemplate}
        interpreter={scriptless ? undefined : interpreter}
        envFrom={scriptless ? undefined : envFrom}
        inputs={childrenWithVariant}
        note={successContent}
        onMarkedDone={onComplete}
        autoCollapse={autoCollapse}
      />
    )
  }

  // Determine if the action button should be disabled
  const isRunDisabled =
    status === "running" ||
    isRendering ||
    (inputDependencies.length > 0 && !hasAllInputDependencies) ||
    !hasAllOutputDependencies ||
    unsignedEnvFrom.length > 0 ||
    isRunBlocked(runBlockers) ||
    (scriptless && status === "success")

  // Main render
  return (
    <AutoCollapse enabled={autoCollapse} done={done}>
      <div
        data-fold="path"
        ref={blockRef}
        data-testid={id}
        className={`runbook-block relative rounded-sm border ${statusClasses} mb-5 p-4`}
      >
        <ProgressStep done={done} />

        {/* ID label - positioned at top right */}
        <div data-fold="keep" className="absolute top-3 right-3 z-20 flex items-center gap-1">
          <BlockIdLabel id={id} size="large" />
          <CollapseButton />
        </div>

        {/* A changed script file can be reviewed and reloaded in place */}
        {path && scriptFileChange && (
          <ScriptChangeNotice
            path={path}
            change={scriptFileChange}
            onReload={reloadScript}
            isReloading={isReloadingScript}
            reloadError={scriptReloadError}
          />
        )}

        {/* Script drift warning - mr-12 leaves room for the ID label */}
        {hasScriptDrift && !scriptFileChange && (
          <Admonition type="warning" title="Script changed" className="space-y-2 mr-12">
            <p>
              This script has changed since the runbook was loaded. Although the <em>UI</em> shows
              the latest version, for security reasons, Runbooks will <em>execute</em> the version
              that was present when the runbook was last opened or reloaded, or, if Runbooks was
              started with{" "}
              <code className="bg-warning-muted px-1 rounded text-xs">
                --disable-live-file-reload
              </code>
              , when it was opened in this app session (opening another runbook and coming back
              rebuilds it).
            </p>
            <p>
              To execute the latest version, close and reopen the runbook (in watch mode, saving{" "}
              <code className="bg-warning-muted px-1 rounded text-xs">runbook.mdx</code> also
              reloads it). If Runbooks was started with{" "}
              <code className="bg-warning-muted px-1 rounded text-xs">
                --disable-live-file-reload
              </code>
              , quit and restart the app instead. If reloading doesn't resolve this, check for
              escape sequences (e.g.{" "}
              <code className="bg-warning-muted px-1 rounded text-xs">\n</code>) in inline commands
              that may be interpreted differently by the browser and backend.
            </p>
          </Admonition>
        )}

        {/* Main container */}
        <div data-fold="path" className="flex @container">
          <div
            data-fold="keep"
            className="border-r border-border pr-2 mr-4 flex flex-col items-center"
          >
            <variant.statusStyles.StatusIcon
              status={status}
              data-testid={`icon-${status}`}
              className={`size-6 ${iconClasses} ${status === "running" ? "animate-spin" : ""}`}
            />
          </div>

          {/* Main body */}
          <div data-fold="path" className="flex-1 min-w-0 space-y-2">
            {variant.showPendingPlaceholder && status === "pending" && command && !title && (
              <div className="text-muted-foreground font-semibold text-sm">Run a command</div>
            )}
            {variant.showPendingPlaceholder &&
              status === "pending" &&
              !command &&
              path &&
              !title && (
                <div className="text-muted-foreground font-semibold text-sm">Run a script</div>
              )}

            {/* Title and description */}
            {resolvedTitle && (
              <div data-fold="title" className="text-md font-bold text-muted-foreground">
                <InlineMarkdown>{resolvedTitle}</InlineMarkdown>
              </div>
            )}
            {/* Folded, a block without a title shows what it runs in its place */}
            {!resolvedTitle && (
              <WhenFolded>
                <div
                  data-fold="title"
                  className={`font-mono text-sm text-muted-foreground truncate ${clearIdLabel}`}
                >
                  {path ?? rawScriptContent.split("\n")[0]}
                </div>
              </WhenFolded>
            )}
            {resolvedDescription && (
              <div className="text-md text-muted-foreground mb-3">
                <InlineMarkdown>{resolvedDescription}</InlineMarkdown>
              </div>
            )}

            {status === "success" && resolvedSuccessMessage && (
              <div className="text-success font-semibold text-sm mb-3">
                <InlineMarkdown>{resolvedSuccessMessage}</InlineMarkdown>
              </div>
            )}
            {status === "warn" && resolvedWarnMessage && (
              <div className="text-warning font-semibold text-sm mb-3">
                <InlineMarkdown>{resolvedWarnMessage}</InlineMarkdown>
              </div>
            )}
            {status === "fail" && resolvedFailMessage && (
              <div className="text-destructive font-semibold text-sm mb-3">
                <InlineMarkdown>{resolvedFailMessage}</InlineMarkdown>
              </div>
            )}
            {status === "running" && resolvedRunningMessage && (
              <div className="text-info font-semibold text-sm mb-3">
                <InlineMarkdown>{resolvedRunningMessage}</InlineMarkdown>
              </div>
            )}
            {status === "success" && successContent && <div className="mb-3">{successContent}</div>}

            {/* Render inline Inputs children if present */}
            {childrenWithVariant && <div className="mb-4">{childrenWithVariant}</div>}

            {/* The env vars the script gets, so they can be checked before Run */}
            {!scriptless && envVars.length > 0 && (
              <EnvVars
                blockId={id}
                envVars={envVars}
                onOverride={overrideOutput}
                onReset={resetOutputOverride}
                disabled={status === "running"}
                className={clearIdLabel}
              />
            )}

            {/* The auth blocks whose sign-in the script runs with */}
            {!scriptless && envFrom.length > 0 && (
              <div data-testid={`${id}-env-from`} className={`text-xs mb-3 ${clearIdLabel}`}>
                <div className="font-semibold text-muted-foreground mb-1">Signed in with</div>
                <div className="font-mono whitespace-pre-wrap break-all text-foreground">
                  {envFrom.join(", ")}
                </div>
              </div>
            )}

            {/* Where the script runs, as written: templates render when it runs */}
            {!scriptless && workingDirTemplate && (
              <div data-testid={`${id}-working-dir`} className={`text-xs mb-3 ${clearIdLabel}`}>
                <div className="font-semibold text-muted-foreground mb-1">Working directory</div>
                <div className="font-mono whitespace-pre-wrap break-all text-foreground">
                  {workingDirTemplate}
                </div>
              </div>
            )}

            {/* The program the interpreter prop runs the script with */}
            {!scriptless && interpreter && (
              <div data-testid={`${id}-interpreter`} className={`text-xs mb-3 ${clearIdLabel}`}>
                <div className="font-semibold text-muted-foreground mb-1">Runs with</div>
                <div className="font-mono whitespace-pre-wrap break-all text-foreground">
                  {interpreter}
                </div>
              </div>
            )}

            {/* Display script metadata for file-based scripts */}
            {variant.showScriptMetadata && scriptMetadata && (
              <div className="text-xs text-muted-foreground flex items-center flex-wrap gap-3 mb-2">
                <span className="inline-flex items-center gap-1">
                  <span className="font-semibold">Language:</span>
                  <span className="font-mono bg-muted rounded">{scriptMetadata.language}</span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="font-semibold">Lines:</span>
                  <span className="font-mono">{scriptMetadata.lines}</span>
                </span>
                {path && (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <span className="font-semibold">Path:</span>
                    <span className="font-mono truncate max-w-xs" title={path}>
                      {path}
                    </span>
                  </span>
                )}
                <button
                  onClick={() => {
                    setShowSourceCode(true)
                    // Scroll to ViewSourceCode section with a slight delay to ensure it's open
                    setTimeout(() => {
                      viewSourceCodeRef.current?.scrollIntoView({
                        behavior: "smooth",
                        block: "nearest",
                      })
                    }, 100)
                  }}
                  className="inline-flex items-center gap-1 text-primary hover:text-primary/80 hover:underline cursor-pointer"
                >
                  View Source Code
                </button>
              </div>
            )}

            {/* Display inline command if present */}
            {displayCommand && (
              <div
                className={`font-mono text-xs mb-3 bg-gray-900 rounded p-3 text-gray-100 whitespace-pre-wrap ${clearIdLabel}`}
              >
                {displayCommand.content}
              </div>
            )}

            {/* Separator */}
            <div className={`border-b border-border ${clearIdLabel}`}></div>

            {/* Show unmet input/output dependencies */}
            {!isRendering && (
              <UnmetDependenciesWarning
                blockType={variant.componentType}
                unmetInputDeps={unmetInputDependencies}
                unmetOutputDeps={unmetOutputDependencies}
              />
            )}

            {hasAllInputDependencies && hasAllOutputDependencies && (
              <UnmetSignInWarning blockIds={unsignedEnvFrom} />
            )}

            <RunBlockedWarning
              blockType={variant.componentType}
              exclusive={exclusive}
              blockers={runBlockers}
              onStop={stopRun}
            />

            {renderError && hasAllOutputDependencies && (
              <div className="mb-3 text-sm text-destructive flex items-start gap-2">
                <XCircle className="size-4 mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <strong>Env render error:</strong> {renderError.message}
                  {renderError.details && (
                    <div className="text-xs mt-1 text-destructive">{renderError.details}</div>
                  )}
                </div>
              </div>
            )}

            {execError && (
              <div className="mb-3 text-sm text-destructive flex items-start gap-2">
                <XCircle className="size-4 mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <strong>{execError.message}</strong>
                  {execError.details && (
                    <div className="text-xs mt-1 text-destructive">{execError.details}</div>
                  )}
                </div>
              </div>
            )}

            <div className="flex items-center w-full justify-between">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isRunDisabled}
                  onClick={() => (scriptless ? completeScriptless() : handleExecute())}
                >
                  {variant.runLabel}
                </Button>
                {!scriptless && (
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
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Expandable sections inside the main box. Without a script there are
          no logs, outputs or source to show. */}
        {!scriptless && (
          <div className="mt-4 space-y-2">
            <ViewLogs
              logs={logs}
              status={status}
              autoOpen={status === "running"}
              blockId={id}
              logFilePath={logFilePath}
            />
            <ViewOutputs
              outputs={outputs}
              autoOpen={outputs !== null && Object.keys(outputs).length > 0}
            />
            {/* Only show ViewSourceCode if path is used */}
            {path && (
              <div ref={viewSourceCodeRef}>
                <ViewSourceCode
                  sourceCode={rawScriptContent}
                  path={path}
                  language={language}
                  fileName={variant.fileName}
                  isOpen={showSourceCode}
                  onToggle={setShowSourceCode}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </AutoCollapse>
  )
}
