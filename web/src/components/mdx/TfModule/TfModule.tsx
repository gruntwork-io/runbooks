import { useEffect, useRef, useState, type FormEvent } from "react"
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileCode,
  Loader2,
  RotateCw,
  TriangleAlert,
} from "lucide-react"
import { useRunbookContext } from "@/contexts/useRunbook"
import { useApi } from "@/contexts/ApiContext"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import { Button } from "@/components/ui/button"
import { useIpc } from "@/hooks/useIpc"
import type { AppError } from "@/types/error"
import { BlockIdLabel } from "../_shared/components/BlockIdLabel"
import { DuplicateIdError } from "../_shared/components/DuplicateIdError"
import { ErrorDisplay } from "../_shared/components/ErrorDisplay"
import { LoadingDisplay } from "../_shared/components/LoadingDisplay"
import { ProgressStep } from "../_shared/components/ProgressStep"
import { useInputRegistration } from "../_shared/hooks/useInputRegistration"
import type { TfModuleSpec } from "../../../../../src/domain/tf-module/types"
import { useBindingError } from "../_shared/hooks/useBindingError"
import { ModuleField } from "./components/ModuleField"
import { ModuleLogo } from "./components/ModuleLogo"
import { Prefill } from "../_shared/components/lookups/Prefill"
import { PrefilledVariable } from "./components/PrefilledVariable"
import { useGitSignIns } from "./hooks/useGitSignIns"
import { LookupEngineContext, useLookupEngine } from "../_shared/hooks/useLookupEngine"
import type { TfModuleGenerated, TfModuleRepo } from "../../../../../electron/shared/channels"
import { inputsKey } from "../../../../../src/domain/tf-module/inputsKey"
import { useGitWorkTree } from "@/contexts/useGitWorkTree"
import {
  formErrors,
  formValue,
  holdsStartingValue,
  publishedValues,
  registryConfig,
  suffixFor,
  unitPath,
  withoutSuffix,
  type FormValues,
} from "./lib"

/**
 * TfModule block: a form for an OpenTofu module's inputs, which generates the
 * code that uses the module.
 *
 * The form comes from the module itself: its `variable` blocks, in any of its
 * .tf and .tofu files, give each input's name, type, default and validation, and the module's runbook_block.yml says how
 * to present them (labels, which inputs come first, what each option means,
 * presets, and lookups that suggest values). The values are published like an
 * <Inputs> block's, so a <Template> or <Command> uses them through `inputsId`.
 *
 * The module declares its lookups in groups, each needing a kind of auth
 * block, and the `auth` prop binds each group the form uses to one of the
 * runbook's auth blocks, which sends the group's requests as its signed-in user.
 *
 * Generate renders the runbook's template with those values and writes the
 * code to its folder in the repository a <GitClone> block cloned, and writes
 * it again as the inputs change. The runbook, not the module, decides how the
 * module is used: a Terragrunt unit, or plain OpenTofu or Terraform code. A
 * <TerragruntApply> block applies a unit from there.
 *
 * @param props.id - Unique identifier for this block (required)
 * @param props.source - The module: a Git source such as
 *   `git::https://github.com/acme/catalog.git//modules/group?ref=v1.0.0`, or a
 *   folder relative to the runbook while working on the module
 * @param props.template - The Boilerplate template for the code that uses the
 *   module, a folder relative to the runbook
 * @param props.path - Where the code goes in the cloned repository, a template
 *   over the inputs such as `groups/{{ .id }}`; the block's id by default
 * @param props.auth - Binds each lookup group the module uses to an auth
 *   block by id, such as `{{ google: "workspace" }}`
 * @param props.prefilledVariables - Values the form starts inputs with, by
 *   input name, in place of the module's defaults: literals, or string
 *   templates over other blocks' outputs such as
 *   `{{ .outputs.apply_group.email }}`, which fill their input once the
 *   outputs exist
 */
interface TfModuleProps {
  id: string
  source: string
  template: string
  path?: string
  auth?: Readonly<Record<string, string>>
  prefilledVariables?: Readonly<Record<string, unknown>>
}

const NO_BINDING: Readonly<Record<string, string>> = {}
const NO_PREFILLS: Readonly<Record<string, unknown>> = {}

/** How long the inputs must settle before generated code is written again. */
const REGENERATE_MS = 500

/** What's wrong with the block's props, if anything. */
function propsError(id: string, source: string, template: string): AppError | null {
  if (!id) {
    return {
      message: "The <TfModule> block requires a non-empty 'id' prop.",
      details: "Please provide a unique 'id' for this block.",
    }
  }
  if (!source) {
    return {
      message: "The <TfModule> block requires a 'source' prop.",
      details:
        "Set 'source' to the module's Git source, such as git::https://github.com/acme/catalog.git//modules/group?ref=v1.0.0, or to its folder relative to the runbook.",
    }
  }
  if (!template) {
    return {
      message: "The <TfModule> block requires a 'template' prop.",
      details:
        "Set 'template' to a Boilerplate template folder, relative to the runbook, for the code that uses the module, such as a terragrunt.hcl or a main.tf.",
    }
  }
  return null
}

function TfModule({
  id,
  source,
  template,
  path,
  auth = NO_BINDING,
  prefilledVariables = NO_PREFILLS,
}: TfModuleProps) {
  const validationError = propsError(id, source, template)

  const {
    data: spec,
    isLoading,
    error: apiError,
    refetch,
  } = useIpc<TfModuleSpec>(validationError ? "" : "tf-module:read", { source })
  // A private repository's module may clone once someone signs in to its host.
  const gitSignIns = useGitSignIns()
  useEffect(() => {
    if (apiError) refetch()
    // Reads again on a sign-in, not when the error or refetch changes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [gitSignIns])
  const config = spec ? registryConfig(spec) : null
  const bindingError = useBindingError(
    spec ? { definitions: spec.definitions, groups: spec.authGroups } : undefined,
    auth,
    "<TfModule>",
    "the module's",
  )
  const prefillError = spec ? prefilledVariablesError(spec, prefilledVariables) : null

  const blockRef = useRef<HTMLDivElement>(null)
  const {
    isDuplicate,
    isNormalizedCollision,
    collidingId,
    initialData,
    hasSubmitted,
    handleAutoUpdate,
    handleSubmit,
  } = useInputRegistration({
    id,
    componentType: "TfModule",
    blockRef,
    boilerplateConfig: config,
    validationError,
    alwaysSubmitted: false,
  })

  if (isDuplicate) {
    return (
      <DuplicateIdError
        id={id}
        isNormalizedCollision={isNormalizedCollision}
        collidingId={collidingId}
      />
    )
  }
  if (validationError) return <ErrorDisplay error={validationError} />
  if (apiError) return <ErrorDisplay error={apiError} />
  if (bindingError) return <ErrorDisplay error={bindingError} />
  if (prefillError) return <ErrorDisplay error={prefillError} />
  if (isLoading || !spec || Object.keys(initialData).length === 0) {
    return <LoadingDisplay message="Reading the module..." />
  }

  return (
    <div ref={blockRef} data-testid={id}>
      <TfModuleForm
        id={id}
        source={source}
        template={template}
        path={path}
        auth={auth}
        prefilledVariables={prefilledVariables}
        spec={spec}
        initialData={initialData}
        hasSubmitted={hasSubmitted}
        onAutoUpdate={handleAutoUpdate}
        onSubmit={handleSubmit}
      />
    </div>
  )
}

/** The `prefilledVariables` the module has no input for, if any. */
function prefilledVariablesError(
  spec: TfModuleSpec,
  prefilledVariables: Readonly<Record<string, unknown>>,
): AppError | null {
  const unknown = Object.keys(prefilledVariables).filter(
    (name) => !spec.variables.some((v) => v.name === name),
  )
  if (unknown.length === 0) return null
  return {
    message: "The <TfModule> block's prefilledVariables prop names inputs the module doesn't have.",
    details: `Unknown: ${unknown.join(", ")}. The module's inputs are ${spec.variables.map((v) => v.name).join(", ")}.`,
  }
}

interface TfModuleFormProps {
  id: string
  source: string
  template: string
  path?: string | undefined
  auth: Readonly<Record<string, string>>
  prefilledVariables: Readonly<Record<string, unknown>>
  spec: TfModuleSpec
  initialData: FormValues
  hasSubmitted: boolean
  onAutoUpdate: (values: FormValues) => void
  onSubmit: (values: FormValues) => Promise<void>
}

function TfModuleForm({
  id,
  source,
  template,
  path,
  auth,
  prefilledVariables,
  spec,
  initialData,
  hasSubmitted,
  onAutoUpdate,
  onSubmit,
}: TfModuleFormProps) {
  const api = useApi()
  const { activeWorkTree } = useGitWorkTree()
  const { registerOutputs } = useRunbookContext()
  const [values, setValues] = useState<FormValues>(() => {
    const saved = Object.fromEntries(
      spec.variables.map((v) => [v.name, formValue(v, initialData[v.name])]),
    )
    return Object.fromEntries(
      spec.variables.map((v) => [v.name, withoutSuffix(saved[v.name], suffixFor(spec, v, saved))]),
    )
  })
  const [touched, setTouched] = useState<Set<string>>(() => new Set())
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const advanced = spec.variables.filter((v) => !v.primary)
  const errors = formErrors(spec, values)
  const [showAdvanced, setShowAdvanced] = useState(
    () => advanced.some((v) => Object.hasOwn(errors, v.name)) && hasSubmitted,
  )
  const generator = useGenerator(api)

  // Changes in one event, such as a prefill and a pick, build on each other
  // instead of on this render's values.
  const latest = useRef(values)
  const update = (changes: FormValues) => {
    const next = { ...latest.current, ...changes }
    latest.current = next
    setValues(next)
    // Blocks that use the inputs, and the code, keep the last valid ones while an input needs a fix.
    if (Object.keys(formErrors(spec, next)).length === 0) onAutoUpdate(publishedValues(spec, next))
  }

  const shownError = (name: string) =>
    submitAttempted || hasSubmitted || touched.has(name) ? errors[name] : undefined

  const isValid = Object.keys(errors).length === 0
  const errorCount = Object.keys(errors).length
  const published = publishedValues(spec, values)
  const engine = useLookupEngine(spec.definitions, auth, published, { module: source })
  const repoPath = unitPath(path, id, published)
  const repo: TfModuleRepo | undefined = activeWorkTree
    ? {
        worktreePath: activeWorkTree.localPath,
        path: repoPath,
        baseBranch: activeWorkTree.gitInfo.ref,
      }
    : undefined
  const request = { blockId: id, source, template, values: published, repo }
  const requestKey = JSON.stringify(request)

  const generate = async (req: typeof request) => {
    const generated = await generator.run(req)
    if (!generated) return
    const { code } = generated
    registerOutputs(id, {
      MODULE_SOURCE: source,
      TEMPLATE: template,
      CODE_PATH: code.kind === "repo" ? code.folder : unitPath(path, id, req.values),
    })
  }

  // Once generated, the code follows the inputs, as a <Template> block's does.
  const [following, setFollowing] = useState(false)
  useEffect(() => {
    if (!following || !isValid || requestKey === generator.lastKey) return
    const timer = setTimeout(
      () => void generate(JSON.parse(requestKey) as typeof request),
      REGENERATE_MS,
    )
    return () => clearTimeout(timer)
    // Writes when the request changes, not when what writes it does.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, following, isValid])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setSubmitAttempted(true)
    if (Object.keys(errors).length > 0) {
      if (advanced.some((v) => Object.hasOwn(errors, v.name))) setShowAdvanced(true)
      return
    }
    setFollowing(true)
    void onSubmit(published).then(() => generate(request))
  }

  const field = (name: string) => {
    const variable = spec.variables.find((v) => v.name === name)!
    return (
      <ModuleField
        key={name}
        blockId={id}
        variable={variable}
        value={values[name]}
        suffix={suffixFor(spec, variable, values)}
        error={shownError(name)}
        onChange={(value) => update({ [name]: value })}
        onBlur={() => setTouched((t) => new Set(t).add(name))}
      />
    )
  }

  const { state: generation } = generator
  const started = generation.kind !== "idle"
  const current =
    generation.kind === "generated" && generation.inputs === inputsKey(published) && isValid

  return (
    <LookupEngineContext.Provider value={engine}>
      <div className="runbook-block relative mb-4 rounded-lg border border-border bg-muted p-6 shadow-sm">
        <ProgressStep done={current} />
        <div className="absolute right-3 top-2">
          <BlockIdLabel id={id} size="large" />
        </div>

        <div className="mb-5 flex items-start gap-3 pr-24">
          <ModuleLogo spec={spec} />
          <div className="min-w-0">
            <div className="text-lg font-semibold text-foreground">{spec.title}</div>
            {spec.description && (
              <div className="text-sm text-muted-foreground">{spec.description}</div>
            )}
            {spec.page && (
              <a
                href={spec.page}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary hover:underline"
              >
                View the OpenTofu module
                <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        </div>

        {spec.warnings.length > 0 && (
          <div className="mb-5 rounded-md border border-warning/30 bg-warning-muted p-3 text-sm text-warning-foreground">
            <p className="flex items-center gap-1.5 font-medium">
              <TriangleAlert className="size-4" /> runbook_block.yml
            </p>
            <ul className="mt-1 list-disc pl-5">
              {spec.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}

        {spec.variables.map((variable) =>
          Object.hasOwn(prefilledVariables, variable.name) ? (
            <PrefilledVariable
              key={variable.name}
              value={prefilledVariables[variable.name]}
              fillable={holdsStartingValue(variable, values[variable.name])}
              onFill={(value) =>
                update({
                  [variable.name]: withoutSuffix(
                    formValue(variable, value),
                    suffixFor(spec, variable, latest.current),
                  ),
                })
              }
            />
          ) : (
            variable.prefill && (
              <Prefill
                key={variable.name}
                prefill={variable.prefill}
                empty={isEmptyValue(values[variable.name])}
                onFill={(value) => update({ [variable.name]: value })}
              />
            )
          ),
        )}
        <form onSubmit={submit} className="space-y-6" noValidate>
          <div className="space-y-5">
            {spec.variables.filter((v) => v.primary).map((v) => field(v.name))}
          </div>

          {advanced.length > 0 && (
            <div className="space-y-5">
              <button
                type="button"
                aria-expanded={showAdvanced}
                onClick={() => setShowAdvanced((open) => !open)}
                className="flex items-center gap-1.5 text-sm font-semibold text-foreground"
              >
                {showAdvanced ? (
                  <ChevronDown className="size-4" />
                ) : (
                  <ChevronRight className="size-4" />
                )}
                Advanced options
                <span className="font-normal text-muted-foreground">({advanced.length})</span>
              </button>
              {showAdvanced && (
                <div className="space-y-5 border-l-2 border-border pl-4">
                  {advanced.map((v) => field(v.name))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-3 border-t border-border pt-4">
            {!started && (
              <Button type="submit" variant="default">
                <FileCode className="size-4" /> Generate
              </Button>
            )}
            {submitAttempted && errorCount > 0 && (
              <p className="text-sm text-destructive">
                {errorCount === 1
                  ? "1 input above needs a fix."
                  : `${errorCount} inputs above need a fix.`}
              </p>
            )}
            <Generation
              state={generation}
              repository={activeWorkTree?.gitInfo.repoName}
              stale={started && !current}
              onRetry={() => void generate(request)}
            />
          </div>
        </form>
      </div>
    </LookupEngineContext.Provider>
  )
}

type GenerationState =
  | { readonly kind: "idle" }
  | { readonly kind: "generating"; readonly last?: TfModuleGenerated | undefined }
  | { readonly kind: "generated"; readonly result: TfModuleGenerated; readonly inputs: string }
  | {
      readonly kind: "failed"
      readonly error: string
      readonly last?: TfModuleGenerated | undefined
    }

/**
 * Writes the block's code, one generate at a time: each one replaces the
 * files the last one wrote, except ones changed since, and a generate that
 * finishes after a newer one started is dropped.
 */
function useGenerator(api: ReturnType<typeof useApi>) {
  const [state, setState] = useState<GenerationState>({ kind: "idle" })
  // What the last generate wrote in each file, so the next one removes only files left as they were.
  const written = useRef<Record<string, string>>({})
  const seq = useRef(0)
  // The request the last generate was for, so the same one isn't written twice.
  const [lastKey, setLastKey] = useState<string | undefined>(undefined)
  const lastResult = (s: GenerationState) =>
    s.kind === "generated" ? s.result : s.kind === "idle" ? undefined : s.last

  const run = async (request: {
    blockId: string
    source: string
    template: string
    values: Record<string, unknown>
    repo?: TfModuleRepo | undefined
  }): Promise<TfModuleGenerated | undefined> => {
    const mine = ++seq.current
    setLastKey(JSON.stringify(request))
    setState((s) => ({ kind: "generating", last: lastResult(s) }))
    try {
      const result = await api.invoke("tf-module:generate", {
        ...request,
        replaces: written.current,
      })
      if (result.written.length > 0) written.current = result.fingerprints
      if (mine !== seq.current) return undefined
      setState({ kind: "generated", result, inputs: inputsKey(request.values) })
      return result
    } catch (err) {
      if (mine !== seq.current) return undefined
      const error = cleanIpcErrorMessage(err instanceof Error ? err.message : String(err))
      setState((s) => ({ kind: "failed", error, last: lastResult(s) }))
      return undefined
    }
  }

  return { state, run, lastKey }
}

/** What the last generate wrote, or why it failed. */
function Generation({
  state,
  repository,
  stale,
  onRetry,
}: {
  state: GenerationState
  repository: string | undefined
  stale: boolean
  /** Generates again with the same inputs, for a failure that wasn't about them. */
  onRetry: () => void
}) {
  if (state.kind === "idle") return null
  if (state.kind === "failed") {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
        <p className="m-0 font-medium text-destructive">The code couldn't be generated.</p>
        <p className="m-0 mt-1 whitespace-pre-wrap text-foreground">{state.error}</p>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          <RotateCw className="size-3.5" /> Try again
        </Button>
      </div>
    )
  }
  const result = state.kind === "generated" ? state.result : state.last
  if (!result) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Generating the code…
      </p>
    )
  }
  const { code, kept } = result
  const paths =
    result.written.length > 0
      ? result.written
      : code.kind === "repo"
        ? code.files.filter((f) => f.status !== "context").map((f) => f.path)
        : code.files.map((f) => f.path)
  const where =
    result.written.length > 0
      ? `Saved in your local clone of ${repository ?? "the repository"}. Nothing is committed or pushed yet:`
      : "Generated, to run in the block's workspace, since no repository is cloned:"
  return (
    <div className="text-sm" data-testid="tf-module-generated">
      <p className="m-0 flex items-center gap-1.5 text-muted-foreground">
        {state.kind === "generating" || stale ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : null}
        {where}
      </p>
      <ul className="m-0 mt-1 list-none pl-0 font-mono text-xs text-foreground">
        {paths.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      {kept.length > 0 && (
        <div
          className="mt-2 rounded-md border border-warning/30 bg-warning-muted p-3 text-warning-foreground"
          role="status"
        >
          <p className="m-0 flex items-center gap-1.5 font-medium">
            <TriangleAlert className="size-4" />
            Kept {kept.length === 1 ? "a file" : "files"} the code no longer needs, since{" "}
            {kept.length === 1 ? "it" : "they"} changed after the block wrote{" "}
            {kept.length === 1 ? "it" : "them"}. Delete {kept.length === 1 ? "it" : "them"} if you
            don't need {kept.length === 1 ? "it" : "them"}:
          </p>
          <ul className="m-0 mt-1 list-none pl-0 font-mono text-xs">
            {kept.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/** Whether a string input holds nothing the user gave, so a prefill can fill it. */
const isEmptyValue = (value: unknown) => value === undefined || value === null || value === ""

TfModule.displayName = "TfModule"

export default TfModule
