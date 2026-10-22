import React from "react"
import { Link2, Pencil, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatVariableLabel } from "../lib/formatVariableLabel"
import {
  useOutputDependencyStatus,
  type OutputDependencyStatus,
} from "../hooks/useOutputDependencyStatus"
import {
  isTemplateValue,
  parseTemplateValue,
  resolvedValueText,
  summarizeTemplateValue,
} from "../lib/templateValue"

const NO_PENDING_OUTPUTS: OutputDependencyStatus = { waitingFor: [], missing: [] }

/**
 * A pill naming a variable (or summarising a computed expression) that a value
 * is linked to. Red when the value uses an output of a block that isn't on the
 * page, so it can never be filled in; yellow while it waits on blocks that
 * haven't run. Hovering names those blocks.
 */
const TemplateToken: React.FC<{ label: string; outputs: OutputDependencyStatus }> = ({
  label,
  outputs: { waitingFor, missing },
}) => {
  const state = missing.length > 0 ? "missing" : waitingFor.length > 0 ? "waiting" : "linked"
  const title = {
    missing:
      missing.length === 1
        ? `No block on this page has the id "${missing[0]}"`
        : `No blocks on this page have the ids ${missing.map((b) => `"${b}"`).join(", ")}`,
    waiting: `Waiting for ${waitingFor.join(", ")} to run`,
    linked: undefined,
  }[state]
  return (
    <span
      title={title}
      data-state={state}
      className={cn(
        "mx-0.5 inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-px align-middle text-xs font-medium",
        {
          missing: "border-destructive/40 bg-destructive-muted text-destructive",
          waiting: "border-warning/40 bg-warning-muted text-warning-foreground",
          linked: "border-border bg-muted text-foreground",
        }[state],
      )}
    >
      <Link2
        className={cn(
          "size-3 shrink-0",
          { missing: "text-destructive", waiting: "text-warning", linked: "text-muted-foreground" }[
            state
          ],
        )}
        aria-hidden="true"
      />
      {label}
    </span>
  )
}

interface TemplateValueTextProps {
  value: unknown
  /** What the value comes to right now, if known (see useResolvedTemplateValues). */
  resolved?: unknown
  id?: string
  className?: string
  /**
   * The value is sensitive: show only what it is linked to ("Based on …"),
   * never its literal text, what it comes to or, on hover, its expression.
   */
  masked?: boolean | undefined
}

/**
 * Shows a value the way a form entry displays it. A template value such as
 * `aws-sso@{{ .EmailDomainName }}` is shown as what it comes to when that is
 * known, with a link icon. Otherwise it becomes its literal text with a token
 * for each referenced variable; a computed one (conditionals, functions)
 * becomes a single "Based on …" token. Hovering shows the raw expression.
 * While the value uses an output a block hasn't produced yet, its tokens are
 * yellow; when no block on the page has that id, they are red. Anything else
 * is shown as String(value).
 */
export const TemplateValueText: React.FC<TemplateValueTextProps> = ({
  value,
  resolved,
  id,
  className,
  masked,
}) => {
  const outputStatus = useOutputDependencyStatus()
  if (!isTemplateValue(value)) return <>{String(value)}</>
  const outputs = outputStatus(value)
  const unmet = outputs.waitingFor.length > 0 || outputs.missing.length > 0

  if (masked) {
    return (
      <span id={id} className={className}>
        <TemplateToken label={summarizeTemplateValue(value)} outputs={outputs} />
      </span>
    )
  }

  // While an output it uses is missing, any resolved value is from before.
  const resolvedText = unmet ? undefined : resolvedValueText(resolved)
  if (resolvedText !== undefined) {
    return (
      <span id={id} title={value} className={className}>
        <Link2
          className="mr-1 inline size-3 align-[-0.125em] text-muted-foreground"
          aria-hidden="true"
        />
        {resolvedText}
      </span>
    )
  }

  const parsed = parseTemplateValue(value)
  return (
    <span id={id} title={value} className={className}>
      {parsed.kind === "segments" ? (
        parsed.segments.map((segment, i) =>
          segment.kind === "text" ? (
            <React.Fragment key={i}>{segment.text}</React.Fragment>
          ) : (
            <TemplateToken
              key={i}
              label={formatVariableLabel(segment.name)}
              outputs={NO_PENDING_OUTPUTS}
            />
          ),
        )
      ) : (
        <TemplateToken label={summarizeTemplateValue(value)} outputs={outputs} />
      )}
    </span>
  )
}

interface LinkedValueChipProps {
  /** The field's id, so its `<label htmlFor>` still points at it. */
  id: string
  /** The raw template expression. */
  expression: string
  /** What the expression comes to right now, if known. */
  resolved?: unknown
  error?: string | undefined
  disabled?: boolean | undefined
  /** The field is sensitive: show only the variables the value is linked to. */
  sensitive?: boolean | undefined
  /** Show the raw expression for editing. */
  onEdit: () => void
  /** Drop the link and start from an empty value. */
  onClear: () => void
}

/**
 * A field-sized stand-in for a text input whose value is a template
 * expression. Clicking it hands over to the text input with the raw
 * expression; the X clears the link. Read-only (no buttons) when disabled.
 */
export const LinkedValueChip: React.FC<LinkedValueChipProps> = ({
  id,
  expression,
  resolved,
  error,
  disabled,
  sensitive,
  onEdit,
  onClear,
}) => {
  const boxClassName = cn(
    "flex w-full items-center gap-2 rounded-md border px-3 py-2",
    error ? "border-destructive" : "border-input",
    disabled
      ? "cursor-not-allowed bg-muted text-muted-foreground"
      : "bg-card text-foreground focus-within:ring-2 focus-within:ring-ring",
  )

  if (disabled) {
    return (
      <div id={id} className={boxClassName}>
        <TemplateValueText
          value={expression}
          resolved={resolved}
          masked={sensitive}
          className="min-w-0 flex-1"
        />
      </div>
    )
  }

  const valueId = `${id}-linked-value`
  return (
    <div className={boxClassName}>
      <button
        type="button"
        id={id}
        onClick={onEdit}
        aria-describedby={valueId}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left focus:outline-none"
      >
        <TemplateValueText
          id={valueId}
          value={expression}
          resolved={resolved}
          masked={sensitive}
          className="min-w-0 flex-1"
        />
        <Pencil className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear linked value"
        title="Clear linked value"
        className="shrink-0 cursor-pointer rounded-sm text-muted-foreground hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
