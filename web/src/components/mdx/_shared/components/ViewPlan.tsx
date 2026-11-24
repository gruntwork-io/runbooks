import { AlertTriangle, ChevronDown, ChevronRight, FileDiff } from "lucide-react"
import { useState } from "react"
import {
  hasChanges,
  type PlanAction,
  type PlanAttributeChange,
  type PlanCounts,
  type PlanResourceChange,
  type PlanSummary,
  type PlanUnit,
} from "@/lib/planSummary"
import { cn } from "@/lib/utils"

interface ViewPlanProps {
  /** What the plans the script wrote to $RUNBOOK_PLAN_DIR will change */
  plan: PlanSummary | null
}

/**
 * Units with changes start open when there are at most this many of them.
 * Past it they start closed, except those that destroy or replace something.
 */
const OPEN_UNITS_LIMIT = 4

/** How an action is shown: the symbol OpenTofu prints for it, a word, and its color. */
const ACTION_STYLE: Record<PlanAction, { symbol: string; label: string; className: string }> = {
  create: { symbol: "+", label: "create", className: "text-success" },
  update: { symbol: "~", label: "update", className: "text-warning" },
  delete: { symbol: "-", label: "destroy", className: "text-destructive" },
  replace: { symbol: "-/+", label: "replace", className: "text-destructive" },
  forget: { symbol: ".", label: "forget", className: "text-warning" },
  import: { symbol: "←", label: "import", className: "text-info" },
  move: { symbol: "→", label: "move", className: "text-info" },
  read: { symbol: "<=", label: "read", className: "text-muted-foreground" },
}

/**
 * The block's plan: for each unit (each plan file in $RUNBOOK_PLAN_DIR), how
 * many resources it adds, changes and destroys, and each change with the
 * attributes it changes. Destroys and replaces come first, and a unit with
 * one starts open, so they can't go unnoticed.
 */
export function ViewPlan({ plan }: ViewPlanProps) {
  const [open, setOpen] = useState(true)
  if (!plan) return null

  const changed = plan.units.filter((u) => hasChanges(u.counts) || !u.planned || u.errored)
  const unchanged = plan.units.filter((u) => !changed.includes(u))
  const destructive = plan.totals.destroy + plan.totals.replace
  const unitWord = plan.units.length === 1 ? "unit" : "units"

  return (
    <div className="border border-border rounded-sm" data-testid="view-plan">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-accent transition-colors cursor-pointer"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
          <FileDiff className="size-4 text-muted-foreground" />
          <span className="text-sm text-foreground">View Plan</span>
        </span>
        <CountBadges counts={plan.totals} />
        <span className="text-xs text-muted-foreground">
          {plan.units.length} {unitWord}
        </span>
        {destructive > 0 && (
          <span className="flex items-center gap-1 rounded-sm bg-destructive-muted px-1.5 py-0.5 text-xs font-medium text-destructive">
            <AlertTriangle className="size-3.5" />
            {destructive} to destroy or replace
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-border bg-muted max-h-[32rem] overflow-y-auto">
          {changed.map((unit) => (
            <UnitSection
              key={unit.name}
              unit={unit}
              defaultOpen={
                changed.length <= OPEN_UNITS_LIMIT ||
                unit.counts.destroy + unit.counts.replace > 0 ||
                !unit.planned ||
                !!unit.errored
              }
            />
          ))}
          {unchanged.length > 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No changes in {unchanged.length} {unchanged.length === 1 ? "unit" : "units"}:{" "}
              <span className="font-mono">{unchanged.map((u) => u.name).join(", ")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** `+2 ~1 -0`, plus replace, import, move and forget when there are any. */
function CountBadges({ counts }: { counts: PlanCounts }) {
  const badges: { key: string; text: string; title: string; className: string; show: boolean }[] = [
    {
      key: "add",
      text: `+${counts.add}`,
      title: "to add",
      className: "text-success",
      show: true,
    },
    {
      key: "change",
      text: `~${counts.change}`,
      title: "to change",
      className: "text-warning",
      show: true,
    },
    {
      key: "destroy",
      text: `-${counts.destroy}`,
      title: "to destroy",
      className: "text-destructive",
      show: true,
    },
    {
      key: "replace",
      text: `-/+${counts.replace}`,
      title: "to replace",
      className: "text-destructive",
      show: counts.replace > 0,
    },
    {
      key: "import",
      text: `←${counts.import}`,
      title: "to import",
      className: "text-info",
      show: counts.import > 0,
    },
    {
      key: "move",
      text: `→${counts.move}`,
      title: "to move",
      className: "text-info",
      show: counts.move > 0,
    },
    {
      key: "forget",
      text: `.${counts.forget}`,
      title: "to forget",
      className: "text-warning",
      show: counts.forget > 0,
    },
  ]
  return (
    <span className="flex items-center gap-2 font-mono text-xs">
      {badges
        .filter((b) => b.show)
        .map((b) => (
          <span key={b.key} className={cn(b.className, "tabular-nums")} title={b.title}>
            {b.text}
            <span className="sr-only"> {b.title}</span>
          </span>
        ))}
    </span>
  )
}

function UnitSection({ unit, defaultOpen }: { unit: PlanUnit; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const failed = unit.result === "failed" || unit.result === "early exit"
  return (
    <div className="border-b border-border last:border-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-accent transition-colors cursor-pointer"
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-mono text-sm text-foreground">{unit.name}</span>
        </span>
        {unit.planned && <CountBadges counts={unit.counts} />}
        {failed && (
          <span className="rounded-sm bg-destructive-muted px-1.5 py-0.5 text-xs text-destructive">
            {unit.result}
          </span>
        )}
        {unit.result === "excluded" && (
          <span className="rounded-sm bg-background px-1.5 py-0.5 text-xs text-muted-foreground">
            excluded
          </span>
        )}
        {unit.errored && (
          <span className="rounded-sm bg-destructive-muted px-1.5 py-0.5 text-xs text-destructive">
            plan errored
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-1 px-3 pb-3 pl-8">
          {unit.error && <p className="text-xs text-destructive">{unit.error}</p>}
          {(unit.reason || unit.cause) && (
            <p className="text-xs text-muted-foreground">
              {[unit.reason, unit.cause].filter(Boolean).join(": ")}
            </p>
          )}
          {!unit.planned && !unit.error && !unit.reason && (
            <p className="text-xs text-muted-foreground">No plan was written for this unit.</p>
          )}
          {unit.resources.map((resource) => (
            <ResourceRow key={resource.address} resource={resource} />
          ))}
          {!!unit.omittedResources && (
            <p className="text-xs text-muted-foreground">
              …and {unit.omittedResources} more. The log has the full plan.
            </p>
          )}
          {unit.outputs.length > 0 && (
            <p className="pt-1 text-xs text-muted-foreground">
              Outputs:{" "}
              {unit.outputs.map((o, i) => (
                <span key={o.name} className="font-mono">
                  {i > 0 && ", "}
                  <span className={ACTION_STYLE[o.action].className}>
                    {ACTION_STYLE[o.action].symbol}
                  </span>
                  {o.name}
                </span>
              ))}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function ResourceRow({ resource }: { resource: PlanResourceChange }) {
  const [open, setOpen] = useState(false)
  const style = ACTION_STYLE[resource.action]
  const expandable = resource.attributes.length > 0
  return (
    <div className="rounded-sm border border-border bg-background">
      <button
        onClick={() => expandable && setOpen(!open)}
        className={cn(
          "flex w-full items-start gap-2 px-2 py-1.5 text-left",
          expandable && "cursor-pointer hover:bg-accent",
        )}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
      >
        <span
          className={cn(
            "w-7 shrink-0 text-center font-mono text-xs font-semibold leading-5",
            style.className,
          )}
          aria-hidden="true"
        >
          {style.symbol}
        </span>
        <span className="min-w-0 flex-1 break-all font-mono text-xs leading-5 text-foreground">
          {resource.address}
          {resource.previousAddress && (
            <span className="text-muted-foreground"> (moved from {resource.previousAddress})</span>
          )}
        </span>
        <span className={cn("shrink-0 text-xs leading-5", style.className)}>
          {style.label}
          {resource.importing && " + import"}
        </span>
        {expandable &&
          (open ? (
            <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          ))}
      </button>
      {open && (
        <div className="border-t border-border px-2 py-1.5">
          <table className="w-full table-fixed font-mono text-xs">
            <tbody>
              {resource.attributes.map((attribute) => (
                <AttributeRow key={attribute.path} attribute={attribute} action={resource.action} />
              ))}
            </tbody>
          </table>
          {!!resource.omittedAttributes && (
            <p className="pt-1 text-xs text-muted-foreground">
              …and {resource.omittedAttributes} more attributes. The log has the full plan.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function AttributeRow({
  attribute,
  action,
}: {
  attribute: PlanAttributeChange
  action: PlanAction
}) {
  const showBefore = action !== "create"
  return (
    <tr className="align-top">
      <td className="w-1/3 break-all py-0.5 pr-3 text-muted-foreground">
        {attribute.path}
        {attribute.forcesReplacement && (
          <span className="block font-sans text-destructive">forces replacement</span>
        )}
      </td>
      <td className="break-all py-0.5">
        {attribute.sensitive ? (
          <span className="italic text-muted-foreground">(sensitive value)</span>
        ) : (
          <>
            {showBefore && (
              <>
                {attribute.before === undefined ? (
                  <span className="italic text-muted-foreground">(none)</span>
                ) : (
                  <span className="text-destructive line-through decoration-destructive/40">
                    {attribute.before}
                  </span>
                )}
                <span className="px-1.5 text-muted-foreground">→</span>
              </>
            )}
            {attribute.unknownAfter ? (
              <span className="italic text-muted-foreground">(known after apply)</span>
            ) : attribute.after === undefined ? (
              <span className="italic text-muted-foreground">(none)</span>
            ) : (
              <span className="text-success">{attribute.after}</span>
            )}
          </>
        )}
      </td>
    </tr>
  )
}
