import { useState, type ReactNode } from "react"
import {
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
import type { LogLine, RunState, RunStep } from "../hooks/useTofuRun"
import { PropertyTree } from "./PropertyTree"

/** The lines of the log shown while it's folded. */
const LOG_TAIL = 6

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

interface ResourceRowProps {
  address: string
  action?: ResourceAction | undefined
  progress?: { progress: ResourceProgress; elapsed?: number } | undefined
  properties: Readonly<Record<string, PropertyValue>>
}

/** A resource, which opens to show its properties. */
function ResourceRow({ address, action, progress, properties }: ResourceRowProps) {
  const [open, setOpen] = useState(false)
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
          <PropertyTree properties={properties} />
        </div>
      )}
    </li>
  )
}

/** Terragrunt's log, folded to its last lines until opened. */
function LogView({ log, running }: { log: readonly LogLine[]; running: boolean }) {
  const [open, setOpen] = useState(false)
  if (log.length === 0) return null
  const shown = open ? log : log.slice(-LOG_TAIL)
  return (
    <div className="rounded-md border border-border bg-card">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {open ? "Terragrunt log" : `Terragrunt log (${log.length} lines)`}
        {running && <Loader2 className="size-3 animate-spin" />}
      </button>
      <pre
        data-testid="tofu-module-log"
        className="max-h-72 overflow-auto border-t border-border px-3 py-2 font-mono text-xs leading-relaxed"
      >
        {shown.map((entry, i) => (
          <div
            key={i}
            className={
              entry.level === "error"
                ? "text-destructive"
                : entry.level === "warn"
                  ? "text-warning-foreground"
                  : "text-foreground/80"
            }
          >
            {entry.line}
          </div>
        ))}
      </pre>
    </div>
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
  onPlan,
  onApply,
  onCancel,
}: ApplyTabProps) {
  const running = state.phase === "planning" || state.phase === "applying"
  const planned = state.plan?.resources ?? []
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
          <ul className="space-y-1.5">
            {planned.map((r) => (
              <ResourceRow
                key={r.address}
                address={r.address}
                action={r.action}
                progress={state.phase === "planned" ? undefined : state.progress[r.address]}
                properties={r.properties}
              />
            ))}
          </ul>
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
            <ul className="space-y-1.5">
              {applied.map((r) => (
                <ResourceRow
                  key={r.address}
                  address={r.address}
                  progress={{ progress: "done" }}
                  properties={r.properties}
                />
              ))}
            </ul>
          </div>
          <OutputList outputs={state.result?.outputs ?? []} meta={outputs} />
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

      <LogView log={state.log} running={running} />
    </div>
  )
}
