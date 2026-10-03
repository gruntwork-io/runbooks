import React from "react"
import { Link2, Pencil, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatVariableLabel } from "../lib/formatVariableLabel"
import {
  isTemplateValue,
  parseTemplateValue,
  resolvedValueText,
  summarizeTemplateValue,
} from "../lib/templateValue"

/** A pill naming a variable (or summarising a computed expression) that a value is linked to. */
const TemplateToken: React.FC<{ label: string }> = ({ label }) => (
  <span className="mx-0.5 inline-flex items-center gap-1 whitespace-nowrap rounded border border-border bg-muted px-1.5 py-px align-middle text-xs font-medium text-foreground">
    <Link2 className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    {label}
  </span>
)

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
 * Anything else is shown as String(value).
 */
export const TemplateValueText: React.FC<TemplateValueTextProps> = ({
  value,
  resolved,
  id,
  className,
  masked,
}) => {
  if (!isTemplateValue(value)) return <>{String(value)}</>

  if (masked) {
    return (
      <span id={id} className={className}>
        <TemplateToken label={summarizeTemplateValue(value)} />
      </span>
    )
  }

  const resolvedText = resolvedValueText(resolved)
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
            <TemplateToken key={i} label={formatVariableLabel(segment.name)} />
          ),
        )
      ) : (
        <TemplateToken label={summarizeTemplateValue(value)} />
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
