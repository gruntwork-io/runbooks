import React from "react"
import { X } from "lucide-react"
import { useAllOutputs } from "@/contexts/useRunbook"
import { cn, normalizeBlockId } from "@/lib/utils"
import { formatVariableLabel } from "../lib/formatVariableLabel"
import { useOutputDependencyStatus } from "../hooks/useOutputDependencyStatus"
import {
  chipKey,
  isTemplateValue,
  parseTemplateValue,
  resolvedValueText,
  summarizeTemplateValue,
  wholeValueKey,
  type TemplateReference,
} from "../lib/templateValue"
import { OutputChip, ValueChip, type ValueChipState } from "./ValueChip"

/**
 * What a form field's chips need from the rest of the form: what the
 * variables they link to are, and the values the user entered in their place
 * (see useEnteredValues).
 */
export interface FieldLinks {
  /** What the variable `name` is now, as text, or undefined when that isn't known or can't be shown. */
  variableValue: (name: string) => string | undefined
  /** Whether the variable `name` is sensitive, so a value entered in its place is too. */
  isSensitive: (name: string) => boolean
  /** The values entered in place of chips, by chip key (see chipKey, wholeValueKey). */
  entered: Readonly<Record<string, string>>
  /** Use `value` in place of what the chip with this key links to. */
  enter: (key: string, value: string) => void
  /** Go back to what the chip with this key links to. */
  reset: (key: string) => void
}

/** A variable a value links to, as a ValueChip showing what that variable is now. */
const VariableChip: React.FC<{
  reference: Extract<TemplateReference, { kind: "ref" }>
  links: FieldLinks | undefined
  disabled: boolean
}> = ({ reference, links, disabled }) => {
  const label = formatVariableLabel(reference.name)
  const key = chipKey(reference)
  const entered = links?.entered[key]
  const state: ValueChipState = entered !== undefined ? "entered" : "linked"
  return (
    <ValueChip
      label={label}
      state={state}
      value={entered ?? links?.variableValue(reference.name)}
      description={
        state === "entered" ? `Entered by hand in place of ${label}.` : `The value of ${label}.`
      }
      sensitive={links?.isSensitive(reference.name)}
      disabled={disabled}
      resetTitle={`Use ${label} again`}
      onEnter={(value) => links?.enter(key, value)}
      onReset={() => links?.reset(key)}
    />
  )
}

/** A block output a value links to, as a ValueChip showing the output once the block has run. */
const LinkedOutputChip: React.FC<{
  reference: Extract<TemplateReference, { kind: "output" }>
  links: FieldLinks | undefined
  disabled: boolean
}> = ({ reference: { ref }, links, disabled }) => {
  const allOutputs = useAllOutputs()
  const key = ref.fullPath
  return (
    <OutputChip
      outputRef={ref}
      output={allOutputs[normalizeBlockId(ref.blockId)]?.values[ref.outputName]}
      override={links?.entered[key]}
      disabled={disabled}
      onEnter={(value) => links?.enter(key, value)}
      onReset={() => links?.reset(key)}
    />
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
  /** What its chips link to, and the values entered in their place. Without it, they show only what they link to. */
  links?: FieldLinks | undefined
  /** Show the chips without letting the user enter values in their place. */
  disabled?: boolean | undefined
}

/**
 * Shows a value the way a form entry displays it. A template value such as
 * `aws-sso@{{ .EmailDomainName }}` is shown as its literal text with a chip
 * for each variable or block output it uses, which shows that variable's
 * value, or the output once its block has run. A computed one (conditionals,
 * functions) becomes a single "Based on …" chip, showing what the value comes
 * to when that is known. Hovering shows the raw expression. While a chip waits
 * on a block that hasn't run, it is yellow; when no block on the page has that
 * id, it is red. Clicking a chip turns it into a field for a value to use in
 * its place (see ValueChip). Anything else is shown as String(value).
 */
export const TemplateValueText: React.FC<TemplateValueTextProps> = ({
  value,
  resolved,
  id,
  className,
  masked,
  links,
  disabled,
}) => {
  const outputStatus = useOutputDependencyStatus()
  if (!isTemplateValue(value)) return <>{String(value)}</>
  const locked = disabled === true || links === undefined
  const parsed = parseTemplateValue(value)

  if (masked || parsed.kind === "computed") {
    const { waitingFor, missing } = outputStatus(value)
    const key = wholeValueKey(value)
    const entered = links?.entered[key]
    const state: ValueChipState =
      entered !== undefined
        ? "entered"
        : missing.length > 0
          ? "missing"
          : waitingFor.length > 0
            ? "waiting"
            : "linked"
    // While an output it uses is missing, any resolved value is from before.
    const known = state === "linked" ? resolvedValueText(resolved) : undefined
    return (
      <span id={id} title={masked ? undefined : value} className={className}>
        <ValueChip
          label={summarizeTemplateValue(value)}
          state={state}
          value={masked ? undefined : (entered ?? known)}
          description={
            {
              entered: "Entered by hand in place of the linked value.",
              linked: "Worked out from the values it links to.",
              waiting: `Waiting for ${waitingFor.join(", ")} to run.`,
              missing:
                missing.length === 1
                  ? `No block on this page has the id "${missing[0]}".`
                  : `No blocks on this page have the ids ${missing.map((b) => `"${b}"`).join(", ")}.`,
            }[state]
          }
          sensitive={masked}
          disabled={locked}
          resetTitle="Use the linked value again"
          onEnter={(entry) => links?.enter(key, entry)}
          onReset={() => links?.reset(key)}
        />
      </span>
    )
  }

  return (
    <span id={id} title={value} className={className}>
      {parsed.segments.map((segment, i) =>
        segment.kind === "text" ? (
          <React.Fragment key={i}>{segment.text}</React.Fragment>
        ) : segment.kind === "ref" ? (
          <VariableChip key={i} reference={segment} links={links} disabled={locked} />
        ) : (
          <LinkedOutputChip key={i} reference={segment} links={links} disabled={locked} />
        ),
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
  /** What the value's chips link to, and the values entered in their place. */
  links?: FieldLinks | undefined
  /** Drop the link and start from an empty value. */
  onClear: () => void
}

/**
 * A field-sized stand-in for a text input whose value is a template
 * expression: its text and chips (see TemplateValueText). The X clears the
 * link. Read-only (no buttons) when disabled. An `<output>`, so the field's
 * `<label>` names it, but a group, not a live region announcing each change.
 */
export const LinkedValueChip: React.FC<LinkedValueChipProps> = ({
  id,
  expression,
  resolved,
  error,
  disabled,
  sensitive,
  links,
  onClear,
}) => (
  <output
    id={id}
    role="group"
    className={cn(
      // px-3 py-2: placed and sized like a text input
      "flex w-full items-center gap-2 rounded-md border px-3 py-2",
      error ? "border-destructive" : "border-input",
      disabled ? "cursor-not-allowed bg-muted text-muted-foreground" : "bg-card text-foreground",
    )}
  >
    <TemplateValueText
      value={expression}
      resolved={resolved}
      masked={sensitive}
      links={links}
      disabled={disabled}
      className="min-w-0 flex-1"
    />
    {!disabled && (
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear linked value"
        title="Clear linked value"
        className="shrink-0 cursor-pointer rounded-sm text-muted-foreground hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-4" />
      </button>
    )}
  </output>
)
