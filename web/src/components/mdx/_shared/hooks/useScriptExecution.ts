import { useState, useRef, useEffect, useMemo, useCallback } from "react"
import type { ReactNode } from "react"
import { useApi } from "@/contexts/ApiContext"
import { useGetFile } from "@/hooks/useApiGetFile"
import { useRunbookContext, useAllOutputs, type TemplateValue } from "@/contexts/useRunbook"
import { useApiExec } from "@/hooks/useApiExec"
import type { ExecState, FilesCapturedEvent, LogEntry } from "@/hooks/useApiExec"
import { useSessionHistory } from "@/contexts/useSessionHistory"
import { restoreRun, runEnded, runStarted } from "@/lib/sessionHistory"
import { useExecutableRegistry } from "@/hooks/useExecutableRegistry"
import { useGeneratedFiles } from "@/hooks/useGeneratedFiles"
import { useGitWorkTree } from "@/contexts/useGitWorkTree"
import { useLogs } from "@/contexts/useLogs"
import { extractInlineInputsId } from "../lib/extractInlineInputsId"
import { extractTemplateDependenciesFromString } from "@/lib/extractTemplateDependencies"
import { computeSha256Hash } from "@/lib/hash"
import { normalizeBlockId } from "@/lib/utils"
import {
  buildTemplatePayload,
  hasEmptyNumericInputs,
  maskTemplateOutputs,
  referencesSensitiveOutput,
  revealTemplateOutputs,
  type BlockOutput,
  type TemplateContext,
} from "@/lib/templateUtils"
import type { OutputValue, OutputValues } from "@/lib/outputValues"
import type { ComponentType, ExecutionStatus } from "../types"
import type { AppError } from "@/types/error"
import { createAppError } from "@/types/error"
import { useScriptFileChange } from "./useScriptFileChange"
import { useTemplateDependencies } from "./useTemplateDependencies"
import { useOutputOverrides } from "./useOutputOverrides"
import {
  applyOverrides,
  envValueParts,
  isOverridden,
  overrideFor,
  type EnvVar,
  type OutputRef,
} from "../lib/outputOverrides"
import type { ScriptFileChange } from "../../../../../../electron/shared/channels.ts"
import {
  parseBlockEnv,
  parseBlockEnvFrom,
  parseBlockInterpreter,
  parseBlockWorkingDir,
  sameBlockEnv,
  type BlockEnv,
} from "../../../../../../src/domain/exec/blockEnv.ts"

interface UseScriptExecutionProps {
  componentId: string
  path?: string | undefined
  command?: string | undefined
  /** Reference to one or more Inputs by ID. When multiple IDs are provided, variables are merged in order (later IDs override earlier ones). */
  inputsId?: string | string[] | undefined
  children?: ReactNode
  componentType: ComponentType
  /** Whether to use PTY (pseudo-terminal) for script execution. Defaults to true. Set to false to use pipes instead, which may be needed for scripts that don't work well with PTY. */
  usePty?: boolean | undefined
  /** Per-execution timeout in milliseconds. When omitted, the executor's default timeout applies. */
  timeoutMs?: number | undefined
  /** The block's `env` prop, as the runbook gives it: checked here (see blockEnv.ts). */
  env?: unknown
  /** The block's `envFrom` prop, as the runbook gives it: checked here (see blockEnv.ts). */
  envFrom?: unknown
  /** The block's `workingDir` prop, as the runbook gives it: checked here (see blockEnv.ts). */
  workingDir?: unknown
  /** The block's `interpreter` prop, as the runbook gives it: checked here against the script (see blockEnv.ts). */
  interpreter?: unknown
}

const NO_ENV: BlockEnv = {}
const NO_ENV_FROM: readonly string[] = []

/**
 * The details under an env render error when the env uses a sensitive
 * output: that render shows it as <redacted>, which a template that processes
 * the value can't handle, while the run renders the real value.
 */
export const SENSITIVE_DISPLAY_RENDER_NOTE =
  "The block shows sensitive outputs as <redacted>, so an env value that processes one (for example with fromJson) can fail here. Running the script uses the real value."

/**
 * How the auto-render treats the env: 'raw' has no template dependencies,
 * the two awaiting modes wait on referenced inputs or block outputs, and
 * 'render' renders it.
 */
type RenderMode = "raw" | "awaiting-inputs" | "awaiting-outputs" | "render"

interface UseScriptExecutionReturn {
  /** The script as it runs: the `command` prop, or the registry's copy of the file. */
  rawScriptContent: string
  language?: string | undefined

  // File loading
  fileError: AppError | null

  // The block's env prop
  /** Its variables' templates by name; none when the prop isn't valid. */
  envTemplates: BlockEnv
  /**
   * Its variables as the script will get them: rendered with the current
   * values, else as written. Sensitive outputs show as <redacted>.
   */
  envVars: EnvVar[]
  /** Why the env prop isn't valid, or null when it is. */
  envError: string | null
  /** The auth blocks the envFrom prop names, in order; none when unset or not valid. */
  envFrom: readonly string[]
  /** Why the envFrom prop isn't valid, or null when it is. */
  envFromError: string | null
  /** The envFrom blocks that haven't signed in, in envFrom's order. Run waits for them. */
  unsignedEnvFrom: string[]
  /** The block's workingDir prop as written, templates included; "" when unset or not valid. */
  workingDirTemplate: string
  /** Why the workingDir prop isn't valid, or null when it is. */
  workingDirError: string | null
  /** The program, with any args, the block's interpreter prop names; "" when unset or not valid. */
  interpreter: string
  /** Why the interpreter prop isn't valid, such as a script that also has a shebang, or null when it is. */
  interpreterError: string | null
  /** Use `value` for an output the env reads, in place of what its block outputs. */
  overrideOutput: (ref: OutputRef, value: OutputValue) => void
  /** Go back to what the output's block outputs. */
  resetOutputOverride: (ref: OutputRef) => void

  // Variables
  /** All input dependency names found in the script (for "missing config" detection) */
  inputDependencies: string[]
  /** Input dependencies that don't have values yet */
  unmetInputDependencies: string[]
  hasAllInputDependencies: boolean
  inlineInputsId: string | null

  // Output dependencies
  /** Ids of the blocks whose outputs the script references */
  outputDependencyBlockIds: string[]
  unmetOutputDependencies: BlockOutput[]
  hasAllOutputDependencies: boolean

  // Template context for prop resolution by callers
  templateContext: TemplateContext

  // Rendering
  isRendering: boolean
  renderError: AppError | null

  // Execution
  status: ExecutionStatus
  logs: LogEntry[]
  /** Absolute path to the on-disk log file for the latest execution, if available. */
  logFilePath: string | null
  execError: AppError | null
  execute: () => void
  cancel: () => void

  // Block outputs (key-value pairs produced by script via $RUNBOOK_OUTPUT).
  // Sensitive ones are Redacted, so ViewOutputs masks them.
  outputs: OutputValues | null

  // Drift detection (script changed on disk since runbook was opened)
  hasScriptDrift: boolean
  /**
   * How a script file differs on disk from the version Run executes, or null
   * when it doesn't. While it is set, the script content above is the version
   * Run executes.
   */
  scriptFileChange: ScriptFileChange | null
  /** Make Run execute the script file as it is in `scriptFileChange`. */
  reloadScript: () => void
  isReloadingScript: boolean
  scriptReloadError: AppError | null
}

/**
 * Shared hook for script execution logic used by Check and Command components.
 * Handles file loading, variable collection, template rendering, and execution.
 */
export function useScriptExecution({
  componentId,
  path,
  command,
  inputsId,
  children,
  componentType,
  usePty,
  timeoutMs,
  env,
  envFrom: envFromProp,
  workingDir,
  interpreter: interpreterProp,
}: UseScriptExecutionProps): UseScriptExecutionReturn {
  // IPC bridge for rendering the script's template
  const api = useApi()

  // Get executable registry to look up executable ID
  const { getExecutableByComponentId, registryVersion } = useExecutableRegistry()

  // Get file tree context for updating when files are captured
  const { updateGeneratedFileTree } = useGeneratedFiles()

  // Get worktree context for triggering immediate changelog refresh
  const { invalidateGitFileTree } = useGitWorkTree()

  // Get logs context for global log aggregation
  const { registerLogs } = useLogs()

  // Get runbook context for registering outputs and getting template context
  const { registerOutputs, getTemplateContext } = useRunbookContext()

  // Get the session's history, which keeps this block's runs
  const history = useSessionHistory()

  // Callback to handle files captured from command execution
  const handleFilesCaptured = useCallback(
    (event: FilesCapturedEvent) => {
      // Update the file tree with the new tree from the backend
      // The fileTree is already validated by Zod in useApiExec
      if (event.fileTree) {
        updateGeneratedFileTree({
          fileTree: event.fileTree,
          truncatedTree: event.truncatedTree,
          totalFiles: event.totalFiles,
          heavyDirs: event.heavyDirs,
        })
      }
      // Trigger immediate changelog refresh so changes appear without waiting for next poll
      invalidateGitFileTree()
    },
    [updateGeneratedFileTree, invalidateGitFileTree],
  )

  // Publishes a finished run's outputs for other blocks to read. This is the
  // only place a run writes them. A run that published none registers an
  // empty map, which withdraws the outputs of the run before it and tells
  // downstream watchers (e.g. AwsAuth block-based detection) "ran but produced
  // no outputs" (an empty entry) apart from "hasn't run yet" (no entry).
  const handleFinished = useCallback(
    (outputValues: OutputValues) => {
      registerOutputs(componentId, outputValues)
    },
    [componentId, registerOutputs],
  )

  // Only load file content if path is provided (not for inline commands)
  const shouldFetchFile = !!path && !command
  const {
    data: fileData,
    error: getFileError,
    silentRefetch: rereadFile,
  } = useGetFile(path || "", shouldFetchFile)

  // Re-read the script file whenever the main process rebuilds the registry.
  // A watch-mode reload rebuilds it even when runbook.mdx was saved unchanged,
  // which neither recompiles the MDX nor remounts this block, so without this
  // the block would keep showing the script it first read while Run executes
  // the rebuilt registry's version. Reloading one script rebuilds its entry.
  const registryVersionRef = useRef(registryVersion)
  useEffect(() => {
    if (registryVersionRef.current === registryVersion) return
    registryVersionRef.current = registryVersion
    if (shouldFetchFile) rereadFile()
  }, [registryVersion, shouldFetchFile, rereadFile])

  // A script file that changes on disk keeps running as the registry's copy
  // until the user reloads it.
  const {
    change: scriptFileChange,
    reload: reloadScript,
    isReloading: isReloadingScript,
    reloadError: scriptReloadError,
  } = useScriptFileChange(
    componentId,
    shouldFetchFile ? getExecutableByComponentId(componentId)?.id : undefined,
  )

  // Determine raw script content: command prop takes precedence over file
  // path. A changed script file shows as the registry's copy, the version
  // Run executes; the file as read here may already be the changed one.
  const fileContent = scriptFileChange ? scriptFileChange.registeredContent : fileData?.content
  const rawScriptContent = command || fileContent || ""
  const language = fileData?.language

  // The block's env prop. MDX passes a new object on every render, so it's
  // keyed by its JSON. Run uses the registry's copy, which the main process
  // read from the runbook (see hasScriptDrift).
  const envKey = env === undefined ? "" : JSON.stringify(env)
  const parsedEnv = useMemo(
    () => parseBlockEnv(envKey === "" ? undefined : JSON.parse(envKey)),
    [envKey],
  )
  const envTemplates = parsedEnv.ok ? parsedEnv.env : NO_ENV
  const envError = parsedEnv.ok ? null : parsedEnv.error

  // Keyed by its JSON, like env
  const envFromKey = envFromProp === undefined ? "" : JSON.stringify(envFromProp)
  const parsedEnvFrom = useMemo(
    () => parseBlockEnvFrom(envFromKey === "" ? undefined : JSON.parse(envFromKey)),
    [envFromKey],
  )
  const envFrom = parsedEnvFrom.ok ? parsedEnvFrom.envFrom : NO_ENV_FROM
  const envFromError = parsedEnvFrom.ok ? null : parsedEnvFrom.error

  const parsedWorkingDir = parseBlockWorkingDir(workingDir)
  const workingDirTemplate = parsedWorkingDir.ok ? parsedWorkingDir.workingDir : ""
  const workingDirError = parsedWorkingDir.ok ? null : parsedWorkingDir.error

  const parsedInterpreter = parseBlockInterpreter(interpreterProp, rawScriptContent)
  const interpreter = parsedInterpreter.ok ? parsedInterpreter.interpreter : ""
  const interpreterError = parsedInterpreter.ok ? null : parsedInterpreter.error

  // The env values made of text and output references. The user can enter any
  // of those outputs by hand (see lib/outputOverrides.ts).
  const envParts = useMemo(
    () =>
      new Map(Object.entries(envTemplates).map(([name, value]) => [name, envValueParts(value)])),
    [envTemplates],
  )
  const overridableOutputs = useMemo(() => {
    const refs = new Map<string, OutputRef>()
    for (const parts of envParts.values()) {
      for (const part of parts ?? []) {
        if (part.kind === "output") refs.set(part.ref.fullPath, part.ref)
      }
    }
    return refs
  }, [envParts])
  const {
    overrides: outputOverrides,
    setOverride: overrideOutput,
    resetOverride: resetOutputOverride,
  } = useOutputOverrides(componentId, overridableOutputs)

  // State for computed hash of inline command content (for drift detection)
  // Store the command along with its hash to avoid race conditions when command prop changes
  const [commandHashResult, setCommandHashResult] = useState<{
    command: string
    hash: string
  } | null>(null)

  // Compute hash of inline command content when it changes
  useEffect(() => {
    if (!command) return

    // Track if this effect instance is still active (handles unmount and re-runs)
    let isActive = true
    void computeSha256Hash(command).then((hash) => {
      if (isActive) {
        setCommandHashResult({ command, hash })
      }
    })

    return () => {
      isActive = false
    }
  }, [command])

  // Detect script drift: when the current content differs from what's registered
  // This applies to both file-based scripts AND inline commands
  const hasScriptDrift = useMemo(() => {
    const executable = getExecutableByComponentId(componentId)
    if (!executable?.contentHash) return false

    // Run uses the registry's env, envFrom, workingDir and interpreter, so a changed prop has drifted too
    if (!sameBlockEnv(executable.env ?? NO_ENV, envTemplates)) return true
    if (!sameIds(executable.envFrom ?? NO_ENV_FROM, envFrom)) return true
    if (executable.workingDir !== workingDirTemplate) return true
    if (executable.interpreter !== interpreter) return true

    // For inline commands, compare computed hash against registry hash
    if (command) {
      // If the hash we have is not for the current command, we can't know the drift status yet.
      // Returning false is a safe default until the new hash is computed.
      if (commandHashResult?.command !== command) {
        return false
      }
      return commandHashResult.hash !== executable.contentHash
    }

    // For file-based scripts, the main process compares the file on disk
    // against the registry's copy
    return scriptFileChange !== null
  }, [
    command,
    commandHashResult,
    scriptFileChange,
    componentId,
    getExecutableByComponentId,
    envTemplates,
    envFrom,
    workingDirTemplate,
    interpreter,
  ])

  // Extract inline Inputs ID from children if present
  const inlineInputsId = useMemo(() => extractInlineInputsId(children), [children])

  // Build the complete list of inputsIds to merge (inline has highest precedence, so it goes last)
  const allInputsIds = useMemo(() => {
    const ids: string[] = []

    // Add external inputsId(s) first
    if (inputsId) {
      if (Array.isArray(inputsId)) {
        ids.push(...inputsId)
      } else {
        ids.push(inputsId)
      }
    }

    // Add inline inputsId last (highest precedence)
    if (inlineInputsId) {
      ids.push(inlineInputsId)
    }

    return ids
  }, [inputsId, inlineInputsId])

  // The inputs and outputs the env and working directory use, so Run waits
  // for them
  const allDeps = useMemo(
    () =>
      extractTemplateDependenciesFromString(
        ...Object.values(envTemplates),
        ...(workingDirTemplate ? [workingDirTemplate] : []),
      ),
    [envTemplates, workingDirTemplate],
  )
  // An output entered by hand isn't waited for
  const neededDeps = useMemo(
    () =>
      allDeps.filter(
        (dep) => dep.type !== "output" || !isOverridden(outputOverrides, dep.fullPath),
      ),
    [allDeps, outputOverrides],
  )

  // Resolve them against the inputs (typed for API requests, flattened for
  // lookups) and block outputs
  const {
    rawInputs: inputs,
    inputs: inputValues,
    outputs: flattenedOutputs,
    inputDeps,
    outputDeps,
    unmetInputDeps: unmetInputDependencies,
    unmetOutputDeps: unmetOutputDependencies,
  } = useTemplateDependencies(neededDeps, allInputsIds.length > 0 ? allInputsIds : undefined)
  // The outputs the block renders with: the entered ones in place of their blocks'
  const outputsWithOverrides = useMemo(
    () => applyOverrides(flattenedOutputs, outputOverrides),
    [flattenedOutputs, outputOverrides],
  )

  const outputDependencyBlockIds = useMemo(
    () => [...new Set(outputDeps.map((dep) => dep.blockId))],
    [outputDeps],
  )
  const hasAllInputDependencies = unmetInputDependencies.length === 0
  const hasAllOutputDependencies = unmetOutputDependencies.length === 0

  // Get all block outputs from context for envFrom sign-ins and sensitive outputs
  const allOutputs = useAllOutputs()

  // An auth block marks its outputs `__AUTHENTICATED` while it's signed in
  const unsignedEnvFrom = useMemo(
    () =>
      envFrom.filter((id) => allOutputs[normalizeBlockId(id)]?.values?.__AUTHENTICATED !== "true"),
    [envFrom, allOutputs],
  )

  // Whether the env's render shows a sensitive output as <redacted> (see the
  // render effect below)
  const displayMasksSensitiveOutput = useMemo(
    () => referencesSensitiveOutput(outputDeps, allOutputs),
    [outputDeps, allOutputs],
  )

  // The env vars rendered with the current values
  const [renderedEnv, setRenderedEnv] = useState<Record<string, string> | null>(null)
  const [renderError, setRenderError] = useState<AppError | null>(null)
  const [isRendering, setIsRendering] = useState(false)

  // A referenced block that hasn't produced its outputs yet puts the env in
  // 'awaiting-outputs'. Rendering then would fail on the missing
  // `{{ .outputs.X.Y }}` keys and surface a confusing template error, so the
  // raw templates show instead (clearing any stale render/error) until the
  // outputs land. The outputs can come back with the values rendered last time
  // (a failed re-run registers {} for the block, then a later run restores
  // them), so the dedupe key must go too or that render would be skipped as a
  // duplicate.
  const renderMode = getRenderMode(
    allDeps.length > 0,
    hasAllInputDependencies,
    hasAllOutputDependencies,
  )
  const [prevRenderMode, setPrevRenderMode] = useState(renderMode)

  // State for registry errors (when executable not found)
  const [registryError, setRegistryError] = useState<AppError | null>(null)

  // Track last rendered variables to prevent duplicate renders
  const lastRenderedVariablesRef = useRef<string | null>(null)
  const autoUpdateTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Track if component is mounted to prevent setState on unmounted component
  const isMountedRef = useRef(true)

  // Monotonic render counter: only the latest render may commit. IPC calls
  // can't be cancelled, so a slower earlier render is dropped instead.
  const renderSeqRef = useRef(0)

  const envVars = useMemo(
    (): EnvVar[] =>
      Object.entries(envTemplates).map(([name, template]) => {
        const value = (discardsRender(renderMode) ? undefined : renderedEnv?.[name]) ?? template
        const parts = envParts.get(name)
        if (!parts) return { name, value }
        return {
          name,
          value,
          parts: parts.map((part) =>
            part.kind === "text"
              ? part
              : {
                  kind: "output",
                  ref: part.ref,
                  output:
                    flattenedOutputs[normalizeBlockId(part.ref.blockId)]?.[part.ref.outputName],
                  override: overrideFor(outputOverrides, part.ref),
                },
          ),
        }
      }),
    [envTemplates, envParts, renderMode, renderedEnv, flattenedOutputs, outputOverrides],
  )

  // The block's last run, from the session's history. The block starts from
  // it, and its outputs go back in the runbook context for the blocks that
  // read them. A run that ended without outputs registers an empty map, as
  // handleFinished did when it ended.
  const [restoredRun] = useState(() => restoreRun(history.saved(componentId, "run")))
  useEffect(() => {
    const ended =
      restoredRun?.status === "success" ||
      restoredRun?.status === "warn" ||
      restoredRun?.status === "fail"
    if (ended) registerOutputs(componentId, restoredRun.outputs ?? {})
  }, [restoredRun, componentId, registerOutputs])

  const handleRunStarted = useCallback(() => {
    history.record(componentId, "run", runStarted())
  }, [history, componentId])

  const handleRunEnded = useCallback(
    (state: ExecState) => {
      history.record(componentId, "run", runEnded(state))
    },
    [history, componentId],
  )

  // Files written to $GENERATED_FILES are auto-captured after successful execution:
  // onFilesCaptured updates the file tree, onFinished registers outputs.
  const {
    state: execState,
    execute: executeScript,
    cancel: cancelExec,
  } = useApiExec({
    onFilesCaptured: handleFilesCaptured,
    onFinished: handleFinished,
    initialState: restoredRun,
    onRunStarted: handleRunStarted,
    onRunEnded: handleRunEnded,
  })

  // Map exec state to our status type, handling warn status for Check components
  // Note: componentType never changes, so we can directly check without memoization
  const status: ExecutionStatus =
    execState.status === "warn" && componentType === "command"
      ? "fail"
      : (execState.status as ExecutionStatus)

  const logs = execState.logs
  const logFilePath = execState.logFilePath
  const execError = execState.error
  const outputs = execState.outputs

  // Register logs with global context whenever they change
  useEffect(() => {
    registerLogs(componentId, logs)
  }, [componentId, logs, registerLogs])

  // Trigger immediate changelog refresh when execution completes successfully.
  // Scripts may write directly to $REPO_FILES without using $GENERATED_FILES,
  // so we need to refresh even when no files_captured event was emitted.
  useEffect(() => {
    if (status === "success" || status === "warn") {
      invalidateGitFileTree()
    }
  }, [status, invalidateGitFileTree])

  // Render the env with inputs. `errorDetails` explains a failed render
  // under its error message.
  const renderEnv = useCallback(
    async (
      renderInputs: TemplateValue[],
      errorDetails = "Failed to render the env with variables",
    ) => {
      // Supersede any pending render request
      const seq = ++renderSeqRef.current
      setRenderError(null)

      // Each env var renders as its own file
      const envNames = Object.keys(envTemplates).filter((name) =>
        envTemplates[name]!.includes("{{"),
      )
      // Only the working directory has templates, and it shows as written
      if (envNames.length === 0) {
        setRenderedEnv({})
        setIsRendering(false)
        return
      }
      setIsRendering(true)
      const templateFiles = Object.fromEntries(
        envNames.map((name) => [`env:${name}`, envTemplates[name]!]),
      )

      try {
        const responseData = await api.invoke("boilerplate:render-inline", {
          templateFiles,
          inputs: renderInputs,
        })

        // Check if component is still mounted and this is still the latest render
        if (!isMountedRef.current || seq !== renderSeqRef.current) return
        const renderedFiles = responseData.renderedFiles ?? {}
        setRenderedEnv(
          Object.fromEntries(
            envNames.flatMap((name) => {
              const file = renderedFiles[`env:${name}`]
              return file ? [[name, file.content]] : []
            }),
          ),
        )
        setIsRendering(false)
      } catch (err) {
        // Check if component is still mounted and this is still the latest render
        if (!isMountedRef.current || seq !== renderSeqRef.current) return

        const errorMessage = err instanceof Error ? err.message : "Unknown error"
        setRenderError(createAppError(errorMessage, errorDetails))
        setIsRendering(false)
      }
    },
    [api, envTemplates],
  )

  // Template context for prop resolution by callers (Command/Check resolve display string props)
  const templateContext = useMemo(
    () => ({ inputs: inputValues, outputs: outputsWithOverrides }),
    [inputValues, outputsWithOverrides],
  )

  // The payload and dedupe key for the next auto-render, or null when the
  // env shouldn't render now.
  const pendingRender = useMemo(() => {
    // Skip render when a numeric input is empty (user is mid-edit, e.g., clearing
    // a number field before typing a new value). Sending "" to the backend would
    // cause type-conversion errors like strconv.Atoi("").
    if (renderMode !== "render" || hasEmptyNumericInputs(inputs)) return null
    // This render is only shown (the run renders again, with the real
    // values), so a sensitive output shows as <redacted>. A template that
    // processes its value (e.g. fromJson) can then fail here and not when the
    // script runs, so such an error says why.
    const errorDetails = displayMasksSensitiveOutput ? SENSITIVE_DISPLAY_RENDER_NOTE : undefined
    const payload = buildTemplatePayload({
      inputs: templateContext.inputs,
      outputs: maskTemplateOutputs(templateContext.outputs),
    })
    // The env is part of the key so a changed env with unchanged values
    // still re-renders.
    return {
      payload,
      key: JSON.stringify([envTemplates, payload]),
      errorDetails,
    }
  }, [renderMode, inputs, templateContext, envTemplates, displayMasksSensitiveOutput])

  const [prevRenderKey, setPrevRenderKey] = useState(pendingRender?.key ?? null)
  if (renderMode !== prevRenderMode) {
    setPrevRenderMode(renderMode)
    if (discardsRender(renderMode)) {
      setIsRendering(false)
      setRenderedEnv(null)
      setPrevRenderKey(null)
      if (renderMode === "awaiting-outputs") {
        setRenderError(null)
      }
    }
  }
  if (pendingRender && pendingRender.key !== prevRenderKey) {
    setPrevRenderKey(pendingRender.key)
    // Clear any stale render error immediately so it doesn't flash while
    // we wait for the debounced re-render with the updated variables.
    setRenderError(null)
  }

  // Auto-update when variables change (debounced).
  // Whenever this effect discards the rendered env it also forgets the last
  // render key, so the next pass with every dependency met renders again even
  // if the values match the ones rendered before, and it drops any render
  // still in flight, which would otherwise land over the raw templates.
  useEffect(() => {
    if (discardsRender(renderMode)) {
      renderSeqRef.current++
      lastRenderedVariablesRef.current = null
      return
    }

    if (!pendingRender || pendingRender.key === lastRenderedVariablesRef.current) {
      return
    }

    // Clear existing timer (handles cleanup when dependencies change)
    if (autoUpdateTimerRef.current) {
      clearTimeout(autoUpdateTimerRef.current)
    }

    // Debounce: wait 300ms after last change before rendering
    const { payload, key, errorDetails } = pendingRender
    autoUpdateTimerRef.current = setTimeout(() => {
      lastRenderedVariablesRef.current = key
      void renderEnv(payload, errorDetails)
    }, 300)

    // Cleanup: clear timer when effect re-runs or on unmount
    return () => {
      if (autoUpdateTimerRef.current) {
        clearTimeout(autoUpdateTimerRef.current)
      }
    }
  }, [renderMode, pendingRender, renderEnv])

  // Handle starting execution
  const execute = useCallback(() => {
    // Clear any previous registry error
    setRegistryError(null)

    // Get the full template context with inputs and outputs namespaces
    const ctx = getTemplateContext(allInputsIds.length > 0 ? allInputsIds : undefined)

    // The execution API expects template_var_values as a nested map matching the
    // Go template dot context: { inputs: { region: "us-west-2" }, outputs: { ... } }.
    // The script runs with the real values of sensitive outputs, and with the
    // outputs entered by hand in place of their blocks'.
    const processedVariables: Record<string, unknown> = {
      inputs: ctx.inputs,
      outputs: revealTemplateOutputs(applyOverrides(ctx.outputs, outputOverrides)),
    }

    // Look up the executable in the registry and run it by executable ID
    const executable = getExecutableByComponentId(componentId)

    if (!executable) {
      // Show error to user instead of silently failing
      setRegistryError(
        createAppError(
          `Executable not found for component "${componentId}"`,
          "This means that Runbooks attempted to run a script or command that was not defined when the runbook was loaded. " +
            "Common causes include changing a script before reloading the runbook, or syntax errors in the command or script path. " +
            "Try closing and reopening your runbook (if Runbooks was started with --disable-live-file-reload, quit and restart the app instead), " +
            "or check the runbooks server logs for details.",
        ),
      )
      return
    }

    executeScript(executable.id, processedVariables, usePty, timeoutMs)
  }, [
    executeScript,
    componentId,
    getExecutableByComponentId,
    allInputsIds,
    getTemplateContext,
    outputOverrides,
    usePty,
    timeoutMs,
  ])

  // Cleanup on unmount: cancel all pending operations
  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false

      // Cancel any ongoing execution
      cancelExec()
    }
  }, [cancelExec])

  // Combine exec error and registry error - show registry error if present
  const combinedExecError = registryError || execError

  return {
    rawScriptContent,
    language,

    // File loading
    fileError: getFileError,

    // The block's env prop
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

    // Variables
    inputDependencies: inputDeps,
    unmetInputDependencies,
    hasAllInputDependencies,
    inlineInputsId,

    // Output dependencies
    outputDependencyBlockIds,
    unmetOutputDependencies,
    hasAllOutputDependencies,

    // Template context for prop resolution
    templateContext,

    // Rendering
    isRendering,
    renderError,

    // Execution
    status,
    logs,
    logFilePath,
    execError: combinedExecError,
    execute,
    cancel: cancelExec,

    // Block outputs
    outputs,

    // Drift detection
    hasScriptDrift,
    scriptFileChange,
    reloadScript,
    isReloadingScript,
    scriptReloadError,
  }
}

function getRenderMode(
  hasTemplateDeps: boolean,
  hasAllInputDependencies: boolean,
  hasAllOutputDependencies: boolean,
): RenderMode {
  if (!hasTemplateDeps) return "raw"
  if (!hasAllInputDependencies) return "awaiting-inputs"
  if (!hasAllOutputDependencies) return "awaiting-outputs"
  return "render"
}

/** Reports whether the mode shows the env as written and drops any rendered one. */
function discardsRender(mode: RenderMode): boolean {
  return mode === "raw" || mode === "awaiting-outputs"
}

/** Whether two lists name the same ids in the same order. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => b[i] === id)
}
