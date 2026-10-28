import { useRef, useState } from "react"
import { Link2, Pencil, RotateCcw } from "lucide-react"
import { usePageBlocks } from "@/contexts/ComponentIdRegistry"
import { isSensitiveOutput, maskOutput, type OutputValue } from "@/lib/outputValues"
import { cn } from "@/lib/utils"
import type { OutputRef } from "../lib/outputOverrides"

/**
 * Where a chip's value comes from: entered by hand, or what it links to,
 * which is known, still to be produced by a block that hasn't run, or can
 * never be, as no block on the page has the id it names.
 */
export type ValueChipState = "entered" | "linked" | "waiting" | "missing"

interface ValueChipProps {
  /** What the chip links to, e.g. `fetch-pr.title` or `Project Name`. Shown while its value isn't known. */
  label: string
  state: ValueChipState
  /** The value it stands for, entered or linked, or undefined while that isn't known. */
  value: string | undefined
  /** Where the value comes from, e.g. "The output of fetch-pr.", shown on hover. */
  description: string
  /** Enter the value in a password field, which never starts with what the chip shows. */
  sensitive?: boolean | undefined
  /** Show the chip without letting the user change it. */
  disabled?: boolean | undefined
  /** What the reset button does, e.g. "Use the output of fetch-pr again". */
  resetTitle: string
  /** Use `value` in place of what the chip links to. */
  onEnter: (value: string) => void
  /** Go back to what the chip links to. */
  onReset: () => void
}

/**
 * A value linked to something else, such as a block's output or another
 * field, shown among the text around it. It shows the value when that is
 * known, else what it links to. Clicking it turns it into a field, in its
 * place, for a value to use instead. An entered value stays in that field,
 * with a button that brings the link back. It sets its own type, so it looks
 * the same in a form field as among a script block's variables.
 */
export function ValueChip({
  label,
  state,
  value,
  description,
  sensitive = false,
  disabled = false,
  resetTitle,
  onEnter,
  onReset,
}: ValueChipProps) {
  // What's in the field while the user is in it, or null when they aren't
  const [draft, setDraft] = useState<string | null>(null)
  // How the user is leaving the field: Enter keeps what's in it, Escape drops it
  const leavingRef = useRef<"enter" | "escape" | null>(null)

  // The field starts from the value the chip stands for, unless it's a secret
  const initial = value === undefined || sensitive ? "" : value

  const text = value === undefined ? label : value === "" ? "(empty)" : value
  const Icon = state === "entered" ? Pencil : Link2
  const chipClassName = cn(
    "mx-0.5 inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-px align-middle font-mono text-xs text-left",
    {
      entered: "border-info/40 bg-info-muted text-foreground",
      linked: "border-border bg-muted text-foreground",
      waiting: "border-warning/40 bg-warning-muted text-warning-foreground",
      missing: "border-destructive/40 bg-destructive-muted text-destructive",
    }[state],
  )
  const chipContent = (
    <>
      <Icon
        className={cn(
          "size-3 shrink-0",
          {
            entered: "text-info",
            linked: "text-muted-foreground",
            waiting: "text-warning",
            missing: "text-destructive",
          }[state],
        )}
        aria-hidden="true"
      />
      <span className={cn("min-w-0", value === "" && "italic")}>{text}</span>
    </>
  )

  if (disabled) {
    return (
      <span data-state={state} title={`${label}: ${description}`} className={chipClassName}>
        {chipContent}
      </span>
    )
  }

  const leave = () => {
    const leaving = leavingRef.current
    leavingRef.current = null
    const entered = draft ?? initial
    setDraft(null)
    // Enter keeps the value even as it was, so a link can be given that
    // value, or an empty one. Leaving the field otherwise keeps a change.
    const keep =
      leaving === "enter"
        ? state !== "entered" || entered !== initial
        : leaving !== "escape" && entered !== initial
    if (keep) onEnter(entered)
  }

  return (
    <span className="inline-flex max-w-full items-center align-middle">
      {state === "entered" || draft !== null ? (
        <input
          type={sensitive ? "password" : "text"}
          data-state={state}
          aria-label={`Value for ${label}`}
          title={`${label}: ${description}`}
          placeholder={sensitive ? "<redacted>" : label}
          value={draft ?? initial}
          // Only when it has just taken the chip's place
          autoFocus={state !== "entered"}
          onFocus={(event) => {
            if (draft === null) setDraft(initial)
            event.currentTarget.select()
          }}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== "Escape") return
            event.preventDefault()
            leavingRef.current = event.key === "Enter" ? "enter" : "escape"
            event.currentTarget.blur()
          }}
          onBlur={leave}
          className={cn(
            "mx-0.5 field-sizing-content min-w-[12ch] max-w-full rounded border px-1.5 py-px align-middle font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring",
            state === "entered" && draft === null
              ? "border-info/40 bg-info-muted"
              : "border-input bg-card",
          )}
        />
      ) : (
        <button
          type="button"
          data-state={state}
          title={`${label}: ${description} Click to enter a value.`}
          aria-label={`${label}: ${value === undefined ? description : text}`}
          onClick={() => setDraft(initial)}
          className={cn(chipClassName, "cursor-pointer hover:border-ring")}
        >
          {chipContent}
        </button>
      )}
      {state === "entered" && (
        <button
          type="button"
          onClick={onReset}
          aria-label={`Reset ${label}`}
          title={resetTitle}
          className="cursor-pointer rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RotateCcw className="size-3" />
        </button>
      )}
    </span>
  )
}

interface OutputChipProps {
  outputRef: OutputRef
  /** What the block outputs, or undefined until it has. */
  output: OutputValue | undefined
  /** The value entered in its place, if any. */
  override: OutputValue | undefined
  disabled?: boolean | undefined
  /** Use `value` in place of the output. `sensitive` when it is a secret, as the output is. */
  onEnter: (value: string, sensitive: boolean) => void
  /** Go back to what the output's block outputs. */
  onReset: () => void
}

/**
 * A block output a value reads, as a ValueChip. It shows the block's output,
 * else, while there is none, which output it is. A sensitive one shows as
 * <redacted>.
 */
export function OutputChip({
  outputRef,
  output,
  override,
  disabled,
  onEnter,
  onReset,
}: OutputChipProps) {
  const { asWritten, isOnPage } = usePageBlocks()

  const source = asWritten(outputRef.blockId)
  const state: ValueChipState =
    override !== undefined
      ? "entered"
      : output !== undefined
        ? "linked"
        : isOnPage(outputRef.blockId) === false
          ? "missing"
          : "waiting"
  const shown = override ?? output
  // A value entered for a sensitive output is kept and shown as one too
  const sensitive =
    (output !== undefined && isSensitiveOutput(output)) ||
    (override !== undefined && isSensitiveOutput(override))

  return (
    <ValueChip
      label={`${outputRef.blockId}.${outputRef.outputName}`}
      state={state}
      value={shown === undefined ? undefined : maskOutput(shown)}
      description={
        {
          entered: `Entered by hand in place of the output of ${source}.`,
          linked: `The output of ${source}.`,
          waiting: `Waiting for ${source} to run.`,
          missing: `No block on this page has the id "${outputRef.blockId}".`,
        }[state]
      }
      sensitive={sensitive}
      disabled={disabled}
      resetTitle={`Use the output of ${source} again`}
      onEnter={(value) => onEnter(value, sensitive)}
      onReset={onReset}
    />
  )
}
