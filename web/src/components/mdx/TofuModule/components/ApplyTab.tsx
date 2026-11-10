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
import type { TofuModuleOutput } from "../../../../../../src/domain/tofu-module/types"
import type {
  ModuleOutputValue,
  PropertyValue,
  ResourceAction,
  ResourceProgress,
} from "../../../../../../src/domain/tofu-module/run"
import type { RunState, RunStep } from "../hooks/useTofuRun"
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

/** Where the run is along Init, Plan, Apply, and reading the outputs. */
function StepRail({ state }: { state: RunState }) {
  const reached = (() => {
    if (state.phase === "applied") return STEPS.length
    if (state.phase === "planned") return 2
    if (state.phase === "failed")
      return state.failed === "apply" ? 2 : state.step === "plan" ? 1 : 0
    const index = STEPS.findIndex((s) => s.step === state.step)
    return index === -1 ? (state.phase === "applying" ? 2 : 0) : index
  })()
  const running = state.phase === "planning" || state.phase === "applying"
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Terragrunt steps">
      {STEPS.map(({ step, label }, i) => {
        const done = i < reached
        const current = i === reached && running
        const failed = state.phase === "failed" && i === reached
        return (
          <li key={step} className="flex items-center gap-1.5">
            {i > 0 && <span className="h-px w-4 bg-border" />}
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                failed
                  ? "border-destructive/40 text-destructive"
                  : done
                    ? "border-success/40 text-success"
                    : current
                      ? "border-primary/40 text-foreground"
                      : "border-border text-muted-foreground"
              }`}
            >
              {failed ? (
                <X className="size-3" />
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
  meta: readonly TofuModuleOutput[]
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

/** The module's outputs: each value, as a link where it's a web address. */
function OutputList({
  outputs,
  meta,
}: {
  outputs: readonly ModuleOutputValue[]
  meta: readonly TofuModuleOutput[]
}) {
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set())
  if (outputs.length === 0) return null
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-foreground">Outputs</h4>
      <dl className="divide-y divide-border rounded-md border border-border bg-card">
        {outputs.map((output) => {
          const info = meta.find((m) => m.name === output.name)
          const hidden = output.sensitive && !revealed.has(output.name)
          let value: ReactNode = <span className="break-all font-mono text-sm">{output.value}</span>
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
    </div>
  )
}

interface ApplyTabProps {
  state: RunState
  stale: boolean
  simulated: boolean
  /** Why the block can't plan yet, such as inputs that need a fix. */
  blocked?: string | undefined
  outputs: readonly TofuModuleOutput[]
  /** The next step, when it's on another tab, such as merging the pull request. */
  next: NextStep | undefined
  onNavigate: (tab: Tab) => void
  onPlan: () => void
  onApply: () => void
  onCancel: () => void
}

/**
 * Terragrunt, run for the block: a plan whose resources open to show their
 * properties, then an apply that shows each resource as it's made, and what
 * it made with the module's outputs.
 */
export function ApplyTab({
  state,
  stale,
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
  const running = state.phase === "planning" || state.phase === "applying"
  const planned = state.plan?.resources ?? []
  const hasUnknown = planned.some((r) =>
    propertyRows(r.properties).some((row) => isUnknown(row.after)),
  )
  const applied = state.result?.resources ?? []
  const counts = planned.reduce<Record<string, number>>(
    (acc, r) => ({ ...acc, [r.action]: (acc[r.action] ?? 0) + 1 }),
    {},
  )
  const summary =
    Object.entries(counts)
      .map(([action, n]) => `${n} to ${action}`)
      .join(", ") || "No changes"

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StepRail state={state} />
        {simulated && (
          <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning-muted px-2 py-0.5 text-xs text-warning-foreground">
            <FlaskConical className="size-3" /> Simulated: nothing real changes
          </span>
        )}
      </div>

      {state.phase === "idle" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Terragrunt plans the code on the Code tab first, so you can see every resource it would
            create before anything changes.
          </p>
          {blocked ? (
            <p className="text-sm text-warning-foreground">{blocked}</p>
          ) : (
            <Button type="button" onClick={onPlan}>
              <Play className="size-4" /> Plan
            </Button>
          )}
        </div>
      )}

      {state.phase === "planning" && (
        <div className="flex items-center gap-3">
          <p className="flex items-center gap-2 text-sm text-foreground">
            <Loader2 className="size-4 animate-spin" />
            {state.step === "plan" ? "Planning…" : "Initializing Terragrunt and OpenTofu…"}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            <Square className="size-3.5" /> Stop
          </Button>
        </div>
      )}

      {(state.phase === "planned" ||
        state.phase === "applying" ||
        (state.phase === "failed" && state.failed === "apply")) && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-foreground">
            {state.phase === "planned" ? `Plan: ${summary}` : "Applying the plan"}
          </h4>
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
            progress={(address) =>
              state.phase === "planned" ? undefined : state.progress[address]
            }
          />
          {state.phase === "planned" && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {stale ? (
                <p className="text-sm text-warning-foreground">
                  The inputs changed since this plan. Plan again to apply them.
                </p>
              ) : (
                planned.length > 0 && (
                  <Button type="button" onClick={onApply}>
                    <Play className="size-4" /> Apply
                  </Button>
                )
              )}
              <Button type="button" variant="outline" onClick={onPlan}>
                <RotateCcw className="size-4" /> Plan again
              </Button>
            </div>
          )}
          {state.phase === "applying" && (
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              <Square className="size-3.5" /> Stop
            </Button>
          )}
        </div>
      )}

      {state.phase === "applied" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success-muted px-3 py-2 text-sm text-success">
            <Check className="size-4" />
            Applied. {applied.length === 1 ? "1 resource" : `${applied.length} resources`} in the
            state.
          </div>
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
              resources={applied}
              filter={{ ...filter, hideUnknown: false, onlyChanged: false }}
              layout={layout}
              progress={() => ({ progress: "done" })}
            />
          </div>
          <RunbookOutputs
            outputs={(state.result?.outputs ?? []).filter((o) => isRunbookOutput(o.name))}
            meta={outputs}
          />
          <OutputList
            outputs={(state.result?.outputs ?? []).filter((o) => !isRunbookOutput(o.name))}
            meta={outputs}
          />
          {next && (
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <Button type="button" onClick={() => onNavigate(next.tab)}>
                {next.label}
                <ArrowRight className="ml-1 size-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      {state.phase === "failed" && (
        <div className="space-y-3">
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <p className="font-medium">
              {state.failed === "apply" ? "The apply failed." : "The plan failed."}
            </p>
            <p className="mt-1">{state.error}</p>
          </div>
          <Button type="button" variant="outline" onClick={onPlan}>
            <RotateCcw className="size-4" /> Plan again
          </Button>
        </div>
      )}

      <LogView title="Terragrunt log" log={state.log} running={running} />
    </div>
  )
}
