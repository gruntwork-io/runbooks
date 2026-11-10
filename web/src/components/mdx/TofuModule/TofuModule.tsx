import { useMemo, useRef, useState, type FormEvent } from "react"
import { ArrowRight, ChevronDown, ChevronRight, FlaskConical, TriangleAlert } from "lucide-react"
import { useRunbookContext } from "@/contexts/useRunbook"
import { sensitiveOutput } from "@/lib/outputValues"
import { Button } from "@/components/ui/button"
import { useIpc } from "@/hooks/useIpc"
import { useSimulation } from "@/contexts/useSimulation"
import type { AppError } from "@/types/error"
import { BlockIdLabel } from "../_shared/components/BlockIdLabel"
import { DuplicateIdError } from "../_shared/components/DuplicateIdError"
import { ErrorDisplay } from "../_shared/components/ErrorDisplay"
import { LoadingDisplay } from "../_shared/components/LoadingDisplay"
import { ProgressStep } from "../_shared/components/ProgressStep"
import { useInputRegistration } from "../_shared/hooks/useInputRegistration"
import type { TofuModuleSpec } from "../../../../../src/domain/tofu-module/types"
import type { LookupRow } from "../../../../../src/domain/tofu-module/rowTemplate"
import { ModuleField } from "./components/ModuleField"
import { ModuleLogo } from "./components/ModuleLogo"
import { CodeTab } from "./components/CodeTab"
import { ApplyTab } from "./components/ApplyTab"
import { PullRequestTab } from "./components/PullRequestTab"
import { useTofuRun } from "./hooks/useTofuRun"
import { useUnitCode } from "./hooks/useUnitCode"
import type { TofuModuleRepo } from "../../../../../electron/shared/channels"
import { usePullRequest, type PullRequestTarget } from "./hooks/usePullRequest"
import { unitPath } from "./pullRequest"
import { nextFrom, stageOf, type Tab } from "./flow"
import { scrollToTop } from "./scrollToTop"
import { useGitWorkTree } from "@/contexts/useGitWorkTree"
import {
  formErrors,
  formValue,
  publishedValues,
  registryConfig,
  suffixFor,
  withoutSuffix,
  type FormValues,
} from "./lib"
import { valuesFromPick } from "./lookupRows"

/**
 * TofuModule block: a form for an OpenTofu module's inputs.
 *
 * The form comes from the module itself: variables.tf gives each input's
 * name, type, default and validation, and the module's runbooks.yml says how
 * to present them (labels, which inputs come first, what each option means,
 * presets, and lookups that suggest values). The values are published like an
 * <Inputs> block's, so a <Template> or <Command> uses them through `inputsId`.
 *
 * Its Code tab shows the Terragrunt code the module's template renders with
 * those values, its Apply tab plans and applies it, and its PR tab opens a
 * GitHub pull request that adds the code to the repository a <GitClone> block
 * cloned. The module's outputs become the block's outputs once it applies.
 *
 * @param props.id - Unique identifier for this block (required)
 * @param props.source - The module's folder, relative to the runbook
 * @param props.path - Where the code goes in the cloned repository, a template
 *   over the inputs such as `groups/{{ .id }}`; the block's id by default
 */
interface TofuModuleProps {
  id: string
  source: string
  path?: string
}

/** The repository a simulated pull request goes to, when no <GitClone> block cloned one. */
const SIMULATED_TARGET: PullRequestTarget = {
  owner: "acme",
  repo: "infrastructure-live",
  baseBranch: "main",
}

function TofuModule({ id, source, path }: TofuModuleProps) {
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <TofuModule> block requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this block.",
      }
    }
    if (!source) {
      return {
        message: "The <TofuModule> block requires a 'source' prop.",
        details: "Set 'source' to the module's folder, relative to the runbook.",
      }
    }
    return null
  }, [id, source])

  const params = useMemo(() => ({ source }), [source])
  const {
    data: spec,
    isLoading,
    error: apiError,
  } = useIpc<TofuModuleSpec>(validationError ? "" : "tofu-module:read", params)
  const config = useMemo(() => (spec ? registryConfig(spec) : null), [spec])

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
    componentType: "TofuModule",
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
  if (isLoading || !spec || Object.keys(initialData).length === 0) {
    return <LoadingDisplay message="Reading the module..." />
  }

  return (
    <div ref={blockRef} data-testid={id}>
      <TofuModuleForm
        id={id}
        source={source}
        path={path}
        spec={spec}
        initialData={initialData}
        hasSubmitted={hasSubmitted}
        onAutoUpdate={handleAutoUpdate}
        onSubmit={handleSubmit}
      />
    </div>
  )
}

const TABS: { tab: Tab; label: string }[] = [
  { tab: "ui", label: "UI" },
  { tab: "code", label: "Code" },
  { tab: "pr", label: "PR" },
  { tab: "apply", label: "Apply" },
]

interface TofuModuleFormProps {
  id: string
  source: string
  path?: string | undefined
  spec: TofuModuleSpec
  initialData: FormValues
  hasSubmitted: boolean
  onAutoUpdate: (values: FormValues) => void
  onSubmit: (values: FormValues) => Promise<void>
}

function TofuModuleForm({
  id,
  source,
  path,
  spec,
  initialData,
  hasSubmitted,
  onAutoUpdate,
  onSubmit,
}: TofuModuleFormProps) {
  const { activeWorkTree } = useGitWorkTree()
  const { state: simulation } = useSimulation()
  const { registerOutputs } = useRunbookContext()
  const [tab, setTab] = useState<Tab>("ui")
  const rootRef = useRef<HTMLDivElement>(null)
  // A Next button moves on to another tab, and scrolls smoothly back to the block's top to start it.
  const goTo = (next: Tab) => {
    setTab(next)
    requestAnimationFrame(() => rootRef.current && scrollToTop(rootRef.current))
  }
  // The file the Code tab shows, kept here so the PR tab can open one there.
  const [codeFile, setCodeFile] = useState<string | undefined>(undefined)
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

  // A pick changes its own input and then the ones its lookup sets, in one
  // event, so each change builds on the last instead of on this render's values.
  const latest = useRef(values)
  const update = (changes: FormValues) => {
    const next = { ...latest.current, ...changes }
    latest.current = next
    setValues(next)
    onAutoUpdate(publishedValues(spec, next))
  }

  const pickFrom = (name: string) => (row: LookupRow) => {
    const lookup = spec.variables.find((v) => v.name === name)?.lookup
    if (lookup?.sets) update(valuesFromPick(lookup, row))
  }

  const shownError = (name: string) =>
    submitAttempted || hasSubmitted || touched.has(name) ? errors[name] : undefined

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setSubmitAttempted(true)
    if (Object.keys(errors).length > 0) {
      if (advanced.some((v) => Object.hasOwn(errors, v.name))) setShowAdvanced(true)
      return
    }
    void onSubmit(publishedValues(spec, values))
    goTo("code")
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
        onPick={pickFrom(name)}
      />
    )
  }

  const isValid = Object.keys(errors).length === 0
  const errorCount = Object.keys(errors).length
  const published = publishedValues(spec, values)
  const repoPath = unitPath(path, id, published)
  const prTarget: PullRequestTarget | undefined = activeWorkTree
    ? {
        worktreePath: activeWorkTree.localPath,
        owner: activeWorkTree.gitInfo.repoOwner,
        repo: activeWorkTree.gitInfo.repoName,
        baseBranch: activeWorkTree.gitInfo.ref,
      }
    : simulation.enabled
      ? SIMULATED_TARGET
      : undefined
  const hasRepo = prTarget !== undefined
  const repo: TofuModuleRepo | undefined = prTarget && {
    worktreePath: prTarget.worktreePath,
    path: repoPath,
    baseBranch: prTarget.baseBranch,
  }
  const run = useTofuRun(id, source, published, repo)
  const pr = usePullRequest(id, source, published, repoPath)
  const unitCode = useUnitCode(id, source, published, repo, tab === "code" || tab === "pr")
  const stage = stageOf({
    inputsValid: isValid,
    hasRepo,
    pr:
      pr.state.phase === "merged"
        ? "merged"
        : pr.state.pr
          ? pr.behind
            ? "behind"
            : "open"
          : "none",
    applied: run.applied,
  })
  const blocked =
    errorCount > 0
      ? `${errorCount === 1 ? "1 input needs" : `${errorCount} inputs need`} a fix on the UI tab first.`
      : undefined

  const apply = async () => {
    const result = await run.apply()
    if (!result) return
    registerOutputs(
      id,
      Object.fromEntries(
        result.outputs.map((o) => [o.name, o.sensitive ? sensitiveOutput(o.value) : o.value]),
      ),
    )
  }

  return (
    <div
      ref={rootRef}
      className="runbook-block relative mb-4 scroll-mt-4 rounded-lg border border-border bg-muted p-6 shadow-sm"
    >
      <ProgressStep done={stage === "done"} />
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
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{source}</span>
            {simulation.enabled && (
              <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning-muted px-2 py-0.5 text-warning-foreground">
                <FlaskConical className="size-3" /> Simulation
              </span>
            )}
          </div>
        </div>
      </div>

      {spec.warnings.length > 0 && (
        <div className="mb-5 rounded-md border border-warning/30 bg-warning-muted p-3 text-sm text-warning-foreground">
          <p className="flex items-center gap-1.5 font-medium">
            <TriangleAlert className="size-4" /> runbooks.yml
          </p>
          <ul className="mt-1 list-disc pl-5">
            {spec.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <div role="tablist" aria-label="Module" className="mb-5 flex gap-1 border-b border-border">
        {TABS.map(({ tab: name, label }) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${id}-tab-${name}`}
            aria-selected={tab === name}
            aria-controls={`${id}-panel-${name}`}
            onClick={() => setTab(name)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm font-medium ${
              tab === name
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "code" && (
        <div role="tabpanel" id={`${id}-panel-code`} aria-labelledby={`${id}-tab-code`}>
          <CodeTab
            code={unitCode.code}
            blockId={id}
            values={published}
            pathTemplate={path}
            moduleFolder={source}
            simulated={simulation.enabled}
            error={unitCode.error}
            repository={
              prTarget && {
                name: `${prTarget.owner}/${prTarget.repo}`,
                baseBranch: prTarget.baseBranch,
              }
            }
            errorCount={errorCount}
            selected={codeFile}
            onSelect={setCodeFile}
          />
          <div className="mt-4 border-t border-border pt-4">
            <NextButton onClick={() => goTo(nextFrom("code", stage, hasRepo)!.tab)} />
          </div>
        </div>
      )}

      <div
        role="tabpanel"
        id={`${id}-panel-pr`}
        aria-labelledby={`${id}-tab-pr`}
        hidden={tab !== "pr"}
      >
        <PullRequestTab
          code={unitCode.code}
          spec={spec}
          values={published}
          path={repoPath}
          target={prTarget}
          simulated={simulation.enabled}
          blocked={blocked}
          applied={run.applied}
          next={nextFrom("pr", stage, hasRepo)}
          pr={pr}
          onOpenFile={(file) => {
            setCodeFile(file)
            setTab("code")
          }}
          onNavigate={goTo}
        />
      </div>

      {/* Kept mounted, so a plan or apply keeps going while another tab shows. */}
      <div
        role="tabpanel"
        id={`${id}-panel-apply`}
        aria-labelledby={`${id}-tab-apply`}
        hidden={tab !== "apply"}
      >
        <ApplyTab
          state={run.state}
          stale={run.stale}
          simulated={simulation.enabled}
          blocked={blocked}
          outputs={spec.outputs}
          next={nextFrom("apply", stage, hasRepo)}
          onNavigate={goTo}
          onPlan={() => void run.plan()}
          onApply={() => void apply()}
          onCancel={run.cancel}
        />
      </div>

      <form
        onSubmit={submit}
        className="space-y-6"
        noValidate
        role="tabpanel"
        id={`${id}-panel-ui`}
        aria-labelledby={`${id}-tab-ui`}
        hidden={tab !== "ui"}
      >
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

        <div className="border-t border-border pt-4">
          <NextButton type="submit" />
          {submitAttempted && errorCount > 0 && (
            <p className="mt-3 text-sm text-destructive">
              {errorCount === 1
                ? "1 input above needs a fix."
                : `${errorCount} inputs above need a fix.`}
            </p>
          )}
        </div>
      </form>
    </div>
  )
}

/** Moves on to the block's next tab. */
function NextButton({
  type = "button",
  onClick,
}: {
  type?: "button" | "submit"
  onClick?: () => void
}) {
  return (
    <Button type={type} variant="default" onClick={onClick}>
      Next
      <ArrowRight className="ml-1 size-4" />
    </Button>
  )
}

TofuModule.displayName = "TofuModule"

export default TofuModule
