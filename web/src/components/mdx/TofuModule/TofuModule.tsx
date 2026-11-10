import { useMemo, useRef, useState, type FormEvent } from "react"
import { ChevronDown, ChevronRight, FlaskConical, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useIpc } from "@/hooks/useIpc"
import { useSimulation } from "@/contexts/useSimulation"
import type { AppError } from "@/types/error"
import { BlockIdLabel } from "../_shared/components/BlockIdLabel"
import { DuplicateIdError } from "../_shared/components/DuplicateIdError"
import { ErrorDisplay } from "../_shared/components/ErrorDisplay"
import { FormStatus } from "../_shared/components/FormStatus"
import { LoadingDisplay } from "../_shared/components/LoadingDisplay"
import { ProgressStep } from "../_shared/components/ProgressStep"
import { useInputRegistration } from "../_shared/hooks/useInputRegistration"
import type { TofuModuleSpec } from "../../../../../src/domain/tofu-module/types"
import type { LookupRow } from "../../../../../src/domain/tofu-module/rowTemplate"
import { ModuleField } from "./components/ModuleField"
import { ModuleLogo } from "./components/ModuleLogo"
import { formErrors, formValue, publishedValues, registryConfig, type FormValues } from "./lib"
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
 * @param props.id - Unique identifier for this block (required)
 * @param props.source - The module's folder, relative to the runbook
 */
interface TofuModuleProps {
  id: string
  source: string
}

function TofuModule({ id, source }: TofuModuleProps) {
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
        spec={spec}
        initialData={initialData}
        hasSubmitted={hasSubmitted}
        onAutoUpdate={handleAutoUpdate}
        onSubmit={handleSubmit}
      />
    </div>
  )
}

interface TofuModuleFormProps {
  id: string
  source: string
  spec: TofuModuleSpec
  initialData: FormValues
  hasSubmitted: boolean
  onAutoUpdate: (values: FormValues) => void
  onSubmit: (values: FormValues) => Promise<void>
}

function TofuModuleForm({
  id,
  source,
  spec,
  initialData,
  hasSubmitted,
  onAutoUpdate,
  onSubmit,
}: TofuModuleFormProps) {
  const { state: simulation } = useSimulation()
  const [values, setValues] = useState<FormValues>(() =>
    Object.fromEntries(spec.variables.map((v) => [v.name, formValue(v, initialData[v.name])])),
  )
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
  }

  const field = (name: string) => {
    const variable = spec.variables.find((v) => v.name === name)!
    return (
      <ModuleField
        key={name}
        blockId={id}
        variable={variable}
        value={values[name]}
        error={shownError(name)}
        onChange={(value) => update({ [name]: value })}
        onBlur={() => setTouched((t) => new Set(t).add(name))}
        onPick={pickFrom(name)}
      />
    )
  }

  const isValid = Object.keys(errors).length === 0
  const done = hasSubmitted && isValid
  const errorCount = Object.keys(errors).length

  return (
    <div
      className={`runbook-block relative mb-4 rounded-lg border p-6 shadow-sm ${
        done ? "border-success/30 bg-success-muted" : "border-border bg-muted"
      }`}
    >
      <ProgressStep done={done} />
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
                <FlaskConical className="size-3" /> Simulated lookups
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

        <div className="border-t border-border pt-4">
          {hasSubmitted ? (
            <FormStatus isValid={isValid} isUpdating={false} isInlineMode />
          ) : (
            <>
              <Button type="submit" variant="default">
                Submit
              </Button>
              {submitAttempted && errorCount > 0 && (
                <p className="mt-3 text-sm text-destructive">
                  {errorCount === 1
                    ? "1 input above needs a fix."
                    : `${errorCount} inputs above need a fix.`}
                </p>
              )}
            </>
          )}
        </div>
      </form>
    </div>
  )
}

TofuModule.displayName = "TofuModule"

export default TofuModule
