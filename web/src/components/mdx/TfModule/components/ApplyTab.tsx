import { useState, type ReactNode } from "react"
import {
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  ChevronRight,
  CircleDashed,
  ExternalLink,
  FlaskConical,
  Loader2,
  Play,
  RotateCcw,
  Search,
  Square,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"
import type { TfModuleOutput } from "../../../../../../src/domain/tf-module/types"
import type {
  ModuleOutputValue,
  PropertyValue,
  ResourceAction,
  ResourceProgress,
} from "../../../../../../src/domain/tf-module/run"
import type { RunPhase, RunState, RunStatus, RunStep } from "../runMachine"
import type { NextStep, Tab } from "../flow"
import {
  filterRows,
  isUnknown,
  NO_FILTER,
  propertyRows,
  type PropertyFilter,
  type PropertyRow,
} from "../propertyRows"
import { LAYOUTS, PropertyView, type PropertyLayout } from "./PropertyViews"
import { LogView } from "./LogView"

const ACTIONS: Record<ResourceAction, { label: string; className: string }> = {
  create: { label: "create", className: "bg-success/15 text-success" },
  update: { label: "update", className: "bg-warning-muted text-warning-foreground" },
  replace: { label: "replace", className: "bg-warning-muted text-warning-foreground" },
  delete: { label: "delete", className: "bg-destructive/10 text-destructive" },
}

const STEPS: { step: RunStep; label: string }[] = [
  { step: "init", label: "Init" },
  { step: "plan", label: "Plan" },
  { step: "apply", label: "Apply" },
  { step: "read", label: "Outputs" },
]

/** How many of Init, Plan, Apply, and reading the outputs the run has finished. */
function stepsDone(phase: RunPhase): number {
  const at = (step: RunStep | undefined, fallback: number) => {
    const index = STEPS.findIndex((s) => s.step === step)
    return index === -1 ? fallback : index
  }
  switch (phase.kind) {
    case "idle":
      return 0
    case "planning":
      return at(phase.step, 0)
    case "planned":
      return 2
    case "applying":
      return at(phase.step, 2)
    case "applied":
      return STEPS.length
    case "stopped":
    case "failed":
      return phase.during === "apply" ? at(phase.step, 2) : at(phase.step, 0)
  }
}

/** Where the run is along Init, Plan, Apply, and reading the outputs. */
function StepRail({ phase }: { phase: RunPhase }) {
  const reached = stepsDone(phase)
  const running = phase.kind === "planning" || phase.kind === "applying"
  const ended = phase.kind === "failed" || phase.kind === "stopped"
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Steps">
      {STEPS.map(({ step, label }, i) => {
        const done = i < reached
        const current = i === reached && running
        const failed = ended && i === reached
        return (
          <li key={step} className="flex items-center gap-1.5">
            {i > 0 && <span className="h-px w-4 bg-border" />}
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                failed
                  ? phase.kind === "failed"
                    ? "border-destructive/40 text-destructive"
                    : "border-warning/40 text-warning-foreground"
                  : done
                    ? "border-success/40 text-success"
                    : current
                      ? "border-primary/40 text-foreground"
                      : "border-border text-muted-foreground"
              }`}
            >
              {failed ? (
                phase.kind === "failed" ? (
                  <X className="size-3" />
                ) : (
                  <Square className="size-3" />
                )
              ) : done ? (
                <Check className="size-3" />
              ) : current ? (
                <Loader2 className="size-3 animate-spin" />
              ) : null}
              {label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function ProgressIcon({ progress }: { progress: ResourceProgress | undefined }) {
  switch (progress) {
    case "working":
      return <Loader2 className="size-4 animate-spin text-primary" aria-label="Working" />
    case "done":
      return <Check className="size-4 text-success" aria-label="Done" />
    case "failed":
      return <X className="size-4 text-destructive" aria-label="Failed" />
    case "waiting":
      return <CircleDashed className="size-4 text-muted-foreground" aria-label="Waiting" />
    case undefined:
      return null
  }
}

interface Resource {
  address: string
  action?: ResourceAction | undefined
  properties: Readonly<Record<string, PropertyValue>>
  before?: Readonly<Record<string, PropertyValue>> | undefined
}

interface ResourceRowProps extends Resource {
  progress?: { progress: ResourceProgress; elapsed?: number } | undefined
  /** The rows the filter keeps. */
  rows: readonly PropertyRow[]
  layout: PropertyLayout
  /** Opened by a search that matched it. */
  found: boolean
}

/** A resource, which opens to show its properties. */
function ResourceRow({
  address,
  action,
  progress,
  properties,
  before,
  rows,
  layout,
  found,
}: ResourceRowProps) {
  const [toggled, setToggled] = useState<boolean | undefined>(undefined)
  const open = toggled ?? found
  const setOpen = (f: (o: boolean) => boolean) => setToggled(f(open))
  return (
    <li className="rounded-md border border-border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
        <ProgressIcon progress={progress?.progress} />
        <span className="min-w-0 flex-1 truncate font-mono text-sm">{address}</span>
        {progress?.elapsed !== undefined && progress.progress !== "waiting" && (
          <span className="text-xs text-muted-foreground">{Math.round(progress.elapsed)}s</span>
        )}
        {action && (
          <span
            className={`rounded px-1.5 py-0.5 text-xs font-medium ${ACTIONS[action].className}`}
          >
            {ACTIONS[action].label}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-border px-4 py-3">
          <PropertyView
            layout={layout}
            rows={rows}
            after={properties}
            before={before}
            action={action}
          />
        </div>
      )}
    </li>
  )
}

/** Narrows the resources' properties, and picks how they're laid out. */
function PropertyToolbar({
  filter,
  onFilter,
  layout,
  onLayout,
  canHideUnknown,
  canShowChanged,
}: {
  filter: PropertyFilter
  onFilter: (filter: PropertyFilter) => void
  layout: PropertyLayout
  onLayout: (layout: PropertyLayout) => void
  canHideUnknown: boolean
  canShowChanged: boolean
}) {
  const chip = (pressed: boolean) =>
    `rounded-full border px-2 py-0.5 text-xs ${
      pressed
        ? "border-primary/50 bg-primary/10 text-foreground"
        : "border-border text-muted-foreground hover:text-foreground"
    }`
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="relative">
        <span className="sr-only">Filter properties</span>
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={filter.query}
          onChange={(e) => onFilter({ ...filter, query: e.target.value })}
          placeholder="Filter properties"
          className="h-7 w-52 rounded-md border border-border bg-background pl-7 pr-2 text-xs outline-none focus:border-primary"
        />
      </label>
      {canHideUnknown && (
        <button
          type="button"
          aria-pressed={filter.hideUnknown}
          className={chip(filter.hideUnknown)}
          onClick={() => onFilter({ ...filter, hideUnknown: !filter.hideUnknown })}
        >
          Only known
        </button>
      )}
      {canShowChanged && (
        <button
          type="button"
          aria-pressed={filter.onlyChanged}
          className={chip(filter.onlyChanged)}
          onClick={() => onFilter({ ...filter, onlyChanged: !filter.onlyChanged })}
        >
          Only changed
        </button>
      )}
      <div
        role="radiogroup"
        aria-label="Layout"
        className="ml-auto inline-flex rounded-md border border-border p-0.5 text-xs"
      >
        {LAYOUTS.map((option) => (
          <button
            key={option.layout}
            type="button"
            role="radio"
            aria-checked={layout === option.layout}
            onClick={() => onLayout(option.layout)}
            className={`rounded px-2 py-0.5 ${
              layout === option.layout
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The resources, each with the rows the filter keeps. A search shows only the
 * resources it matches, opened.
 */
function ResourceList({
  resources,
  filter,
  layout,
  progress,
}: {
  resources: readonly Resource[]
  filter: PropertyFilter
  layout: PropertyLayout
  progress: (address: string) => ResourceRowProps["progress"]
}) {
  const searching = filter.query.trim() !== ""
  const shown = resources
    .map((r) => ({ r, rows: filterRows(propertyRows(r.properties, r.before), filter, r.address) }))
    .filter(({ rows }) => !searching || rows.length > 0)
  if (shown.length === 0) {
    return <p className="text-sm text-muted-foreground">No resources match.</p>
  }
  return (
    <ul className="space-y-1.5">
      {shown.map(({ r, rows }) => (
        <ResourceRow
          key={r.address}
          {...r}
          progress={progress(r.address)}
          rows={rows}
          layout={layout}
          found={searching}
        />
      ))}
    </ul>
  )
}

function CopyValue({ text }: { text: string }) {
  const { didCopy, copy } = useCopyToClipboard()
  return (
    <button
      type="button"
      aria-label="Copy value"
      onClick={() => void copy(text)}
      className="text-muted-foreground hover:text-foreground"
    >
      {didCopy ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  )
}

const isWebLink = (value: string) => /^https:\/\/\S+$/.test(value)

/** An output the module has for the runbook rather than for its callers, such as a console link. */
const isRunbookOutput = (name: string) => name.startsWith("runbooks_")

/** The runbook's outputs: links as buttons, and anything else as a labeled value. */
function RunbookOutputs({
  outputs,
  meta,
}: {
  outputs: readonly ModuleOutputValue[]
  meta: readonly TfModuleOutput[]
}) {
  if (outputs.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      {outputs.map((output) => {
        const info = meta.find((m) => m.name === output.name)
        const label = info?.label ?? output.name
        if (!output.sensitive && isWebLink(output.value)) {
          return (
            <Button key={output.name} asChild variant="outline" size="sm">
              <a href={output.value} target="_blank" rel="noreferrer" title={label}>
                {info?.link ?? label}
                <ExternalLink className="ml-1 size-3.5" />
              </a>
            </Button>
          )
        }
        return (
          <span
            key={output.name}
            className="inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-1 text-sm"
          >
            <span className="text-muted-foreground">{label}</span>
            <span className="font-mono">{output.sensitive ? "••••••••" : output.value}</span>
            {!output.sensitive && <CopyValue text={output.value} />}
          </span>
        )
      })}
    </div>
  )
}

/**
 * The module's outputs: the runbook's own first, then a table of the rest, each
 * value a link where it's a web address.
 */
function OutputList({
  outputs: all,
  meta,
}: {
  outputs: readonly ModuleOutputValue[]
  meta: readonly TfModuleOutput[]
}) {
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set())
  if (all.length === 0) return null
  const outputs = all.filter((o) => !isRunbookOutput(o.name))
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-foreground">Outputs</h4>
      <RunbookOutputs outputs={all.filter((o) => isRunbookOutput(o.name))} meta={meta} />
      {outputs.length > 0 && (
        <dl className="divide-y divide-border rounded-md border border-border bg-card">
          {outputs.map((output) => {
            const info = meta.find((m) => m.name === output.name)
            const hidden = output.sensitive && !revealed.has(output.name)
            let value: ReactNode = (
              <span className="break-all font-mono text-sm">{output.value}</span>
            )
            if (hidden)
              value = <span className="font-mono text-sm text-muted-foreground">••••••••</span>
            else if (isWebLink(output.value)) {
              value = (
                <a
                  href={output.value}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  {info?.link ?? output.value}
                  <ExternalLink className="size-3.5" />
                </a>
              )
            }
            return (
              <div
                key={output.name}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2"
              >
                <dt className="w-40 shrink-0">
                  <div className="text-sm text-foreground">{info?.label ?? output.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">{output.name}</div>
                </dt>
                <dd className="flex min-w-0 flex-1 items-center gap-2">
                  {value}
                  {output.sensitive && (
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        setRevealed((r) => {
                          const next = new Set(r)
                          if (next.has(output.name)) next.delete(output.name)
                          else next.add(output.name)
                          return next
                        })
                      }
                    >
                      {hidden ? "Show" : "Hide"}
                    </button>
                  )}
                  {!hidden && <CopyValue text={output.value} />}
                </dd>
              </div>
            )
          })}
        </dl>
      )}
    </div>
  )
}

interface ApplyTabProps {
  state: RunState
  /** What the run means for the inputs as they are now. */
  status: RunStatus
  simulated: boolean
  /** Why the block can't plan yet, such as inputs that need a fix. */
  blocked?: string | undefined
  outputs: readonly TfModuleOutput[]
  /** The next step, when it's on another tab, such as merging the pull request. */
  next: NextStep | undefined
  onNavigate: (tab: Tab) => void
  onPlan: () => void
  onApply: () => void
  onCancel: () => void
}

/** A note above the run's results, in the tone of what it says. */
function Notice({
  tone,
  children,
}: {
  tone: "success" | "warning" | "error"
  children: ReactNode
}) {
  const styles = {
    success: "border-success/30 bg-success-muted text-success",
    warning: "border-warning/30 bg-warning-muted text-warning-foreground",
    error: "border-destructive/30 bg-destructive/5 text-destructive",
  }
  return <div className={`rounded-md border px-3 py-2 text-sm ${styles[tone]}`}>{children}</div>
}

/**
 * Terragrunt, run for the block: a plan whose resources open to show their
 * properties, then an apply that shows each resource as it's made, and what
 * it made with the module's outputs. What it offers next follows the run's
 * state and whether it's still for the inputs as they are now.
 */
export function ApplyTab({
  state,
  status,
  simulated,
  blocked,
  outputs,
  next,
  onNavigate,
  onPlan,
  onApply,
  onCancel,
}: ApplyTabProps) {
  const [filter, setFilter] = useState<PropertyFilter>(NO_FILTER)
  const [layout, setLayout] = useState<PropertyLayout>("table")
  const { phase } = state
  const running = phase.kind === "planning" || phase.kind === "applying"
  const plan = "plan" in phase ? phase.plan : undefined
  const planned = plan?.resources ?? []
  const progress = "progress" in phase ? phase.progress : undefined
  const hasUnknown = planned.some((r) =>
    propertyRows(r.properties).some((row) => isUnknown(row.after)),
  )
  const counts = planned.reduce<Record<string, number>>(
    (acc, r) => ({ ...acc, [r.action]: (acc[r.action] ?? 0) + 1 }),
    {},
  )
  const summary =
    Object.entries(counts)
      .map(([action, n]) => `${n} to ${action}`)
      .join(", ") || "No changes"

  const planButton = (label: string, variant: "default" | "outline") =>
    blocked ? (
      <p className="m-0 text-sm text-warning-foreground">{blocked}</p>
    ) : (
      <Button type="button" variant={variant} onClick={onPlan}>
        {variant === "default" ? <Play className="size-4" /> : <RotateCcw className="size-4" />}{" "}
        {label}
      </Button>
    )
  const stopButton = (
    <Button type="button" variant="outline" size="sm" onClick={onCancel}>
      <Square className="size-3.5" /> Stop
    </Button>
  )
  const nextButton = next && status === "current" && (
    <Button type="button" onClick={() => onNavigate(next.tab)}>
      {next.label}
      <ArrowRight className="ml-1 size-4" />
    </Button>
  )
  const resourceList = (heading: string) => (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-foreground">{heading}</h4>
      <PropertyToolbar
        filter={filter}
        onFilter={setFilter}
        layout={layout}
        onLayout={setLayout}
        canHideUnknown={hasUnknown}
        canShowChanged={planned.some((r) => r.before !== undefined)}
      />
      <ResourceList
        resources={planned}
        filter={filter}
        layout={layout}
        progress={(address) => progress?.[address]}
      />
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StepRail phase={phase} />
        {simulated && (
          <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning-muted px-2 py-0.5 text-xs text-warning-foreground">
            <FlaskConical className="size-3" /> Simulated: nothing real changes
          </span>
        )}
      </div>

      {phase.kind === "idle" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Apply plans the code on the Code tab first, so you can see every resource it would
            create before anything changes.
          </p>
          {planButton("Plan", "default")}
        </div>
      )}

      {phase.kind === "planning" && (
        <div className="flex items-center gap-3">
          <p className="flex items-center gap-2 text-sm text-foreground">
            <Loader2 className="size-4 animate-spin" />
            {phase.step === "plan" ? "Planning…" : "Initializing…"}
          </p>
          {stopButton}
        </div>
      )}

      {phase.kind === "planned" && (
        <div className="space-y-3">
          {resourceList(`Plan: ${summary}`)}
          {status === "stale" && (
            <Notice tone="warning">
              The inputs changed since this plan. Plan again to apply them.
            </Notice>
          )}
          {status === "current" && (
            <Notice tone="success">
              Nothing to change: the infrastructure already matches these inputs.
            </Notice>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {status === "ready" && (
              <Button type="button" onClick={onApply}>
                <Play className="size-4" /> Apply
              </Button>
            )}
            {planButton("Plan again", status === "stale" ? "default" : "outline")}
            {nextButton}
          </div>
        </div>
      )}

      {phase.kind === "applying" && (
        <div className="space-y-3">
          {resourceList("Applying the plan")}
          {stopButton}
        </div>
      )}

      {phase.kind === "applied" && (
        <div className="space-y-4">
          {status === "stale" ? (
            <div className="space-y-2">
              <Notice tone="warning">
                The inputs changed since this apply, so what's below is for the old ones. Plan again
                to apply the new ones.
              </Notice>
              {planButton("Plan", "default")}
            </div>
          ) : (
            <Notice tone="success">
              <span className="flex items-center gap-2">
                <Check className="size-4" />
                Applied.{" "}
                {phase.result.resources.length === 1
                  ? "1 resource"
                  : `${phase.result.resources.length} resources`}{" "}
                in the state.
              </span>
            </Notice>
          )}
          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-foreground">Resources</h4>
            <PropertyToolbar
              filter={filter}
              onFilter={setFilter}
              layout={layout}
              onLayout={setLayout}
              canHideUnknown={false}
              canShowChanged={false}
            />
            <ResourceList
              resources={phase.result.resources}
              filter={{ ...filter, hideUnknown: false, onlyChanged: false }}
              layout={layout}
              progress={() => ({ progress: "done" })}
            />
          </div>
          <OutputList outputs={phase.result.outputs} meta={outputs} />
          {nextButton && (
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              {nextButton}
            </div>
          )}
        </div>
      )}

      {phase.kind === "stopped" && (
        <div className="space-y-3">
          {phase.during === "apply" && resourceList("What the apply did before it stopped")}
          <Notice tone="warning">
            {phase.during === "apply"
              ? "You stopped the apply. Resources it finished stay; plan again to see what's left to do."
              : "You stopped the plan. Nothing changed."}
          </Notice>
          {planButton("Plan again", "outline")}
        </div>
      )}

      {phase.kind === "failed" && (
        <div className="space-y-3">
          {phase.during === "apply" && resourceList("What the apply did before it failed")}
          <Notice tone="error">
            <p className="m-0 font-medium">
              {phase.during === "apply" ? "The apply failed." : "The plan failed."}
            </p>
            <p className="m-0 mt-1">{phase.error}</p>
          </Notice>
          {planButton("Plan again", "outline")}
        </div>
      )}

      <LogView title="Log" log={state.log} running={running} />
    </div>
  )
}
