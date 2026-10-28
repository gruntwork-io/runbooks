import { Fragment, useRef, useState } from "react"
import { Link2, Pencil, RotateCcw } from "lucide-react"
import { usePageBlocks } from "@/contexts/ComponentIdRegistry"
import {
  isSensitiveOutput,
  maskOutput,
  sensitiveOutput,
  type OutputValue,
} from "@/lib/outputValues"
import { cn } from "@/lib/utils"
import type { EnvVar, EnvVarPart, OutputRef } from "../lib/outputOverrides"

interface EnvVarsProps {
  blockId: string
  envVars: EnvVar[]
  /** Use `value` for an output in place of what its block outputs. */
  onOverride: (ref: OutputRef, value: OutputValue) => void
  /** Go back to what the output's block outputs. */
  onReset: (ref: OutputRef) => void
  /** Show the outputs without letting the user change them, as while the script runs. */
  disabled?: boolean
  className?: string
}

/**
 * The env vars a script block's script gets, so they can be checked before
 * Run. Each output a value reads is a chip, which turns into a field for
 * another value when clicked (see lib/outputOverrides.ts).
 */
export function EnvVars({
  blockId,
  envVars,
  onOverride,
  onReset,
  disabled = false,
  className,
}: EnvVarsProps) {
  return (
    <div data-testid={`${blockId}-env`} className={cn("text-xs mb-3", className)}>
      <div className="font-semibold text-muted-foreground mb-1">Environment variables</div>
      {/* minmax(0, 1fr): a field sized to a long value would otherwise widen
          the column past the block's edge, rather than scroll */}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono">
        {envVars.map(({ name, value, parts }) => (
          <div key={name} className="contents">
            <dt className="text-muted-foreground">{name}</dt>
            <dd className="whitespace-pre-wrap break-all text-foreground">
              {parts
                ? parts.map((part, i) =>
                    part.kind === "text" ? (
                      <Fragment key={i}>{part.text}</Fragment>
                    ) : (
                      <OutputChip
                        key={i}
                        part={part}
                        disabled={disabled}
                        onOverride={onOverride}
                        onReset={onReset}
                      />
                    ),
                  )
                : value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

type OutputChipState = "entered" | "linked" | "waiting" | "missing"

interface OutputChipProps {
  part: Extract<EnvVarPart, { kind: "output" }>
  disabled: boolean
  onOverride: (ref: OutputRef, value: OutputValue) => void
  onReset: (ref: OutputRef) => void
}

/**
 * One output an env value reads. It shows the value the script will get: the
 * block's output, else, while there is none, which output it is. Clicking it
 * turns it into a field, in its place, for a value to use instead. An entered
 * value stays in that field, with a button that brings the output back.
 */
function OutputChip({ part, disabled, onOverride, onReset }: OutputChipProps) {
  const { ref: outputRef, output, override } = part
  const { asWritten, isOnPage } = usePageBlocks()
  // What's in the field while the user is in it, or null when they aren't
  const [draft, setDraft] = useState<string | null>(null)
  // How the user is leaving the field: Enter keeps what's in it, Escape drops it
  const leavingRef = useRef<"enter" | "escape" | null>(null)

  const label = `${outputRef.blockId}.${outputRef.outputName}`
  const source = asWritten(outputRef.blockId)
  const state: OutputChipState =
    override !== undefined
      ? "entered"
      : output !== undefined
        ? "linked"
        : isOnPage(outputRef.blockId) === false
          ? "missing"
          : "waiting"
  const shown = override ?? output
  const shownText = shown === undefined ? undefined : maskOutput(shown)
  // A value entered for a sensitive output is kept and shown as one too
  const sensitive =
    (output !== undefined && isSensitiveOutput(output)) ||
    (override !== undefined && isSensitiveOutput(override))
  // The field starts from the value the script would get, unless it's a secret
  const initial = shownText === undefined || sensitive ? "" : shownText

  const description = {
    entered: `Entered by hand in place of the output of ${source}.`,
    linked: `The output of ${source}.`,
    waiting: `Waiting for ${source} to run.`,
    missing: `No block on this page has the id "${outputRef.blockId}".`,
  }[state]

  const text = shownText === undefined ? label : shownText === "" ? "(empty)" : shownText
  const Icon = state === "entered" ? Pencil : Link2
  const chipClassName = cn(
    "mx-0.5 inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-px align-middle text-left",
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
      <span className={cn("min-w-0", shownText === "" && "italic")}>{text}</span>
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
    const value = draft ?? initial
    setDraft(null)
    // Enter keeps the value even as it was, so an output can be given that
    // value, or an empty one. Leaving the field otherwise keeps a change.
    const keep =
      leaving === "enter"
        ? state !== "entered" || value !== initial
        : leaving !== "escape" && value !== initial
    if (keep) onOverride(outputRef, sensitive ? sensitiveOutput(value) : value)
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
          aria-label={`${label}: ${shownText === undefined ? description : text}`}
          onClick={() => setDraft(initial)}
          className={cn(chipClassName, "cursor-pointer hover:border-ring")}
        >
          {chipContent}
        </button>
      )}
      {state === "entered" && (
        <button
          type="button"
          onClick={() => onReset(outputRef)}
          aria-label={`Reset ${label}`}
          title={`Use the output of ${source} again`}
          className="cursor-pointer rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RotateCcw className="size-3" />
        </button>
      )}
    </span>
  )
}
