import { Fragment } from "react"
import { sensitiveOutput, type OutputValue } from "@/lib/outputValues"
import { cn } from "@/lib/utils"
import type { EnvVar, OutputRef } from "../lib/outputOverrides"
import { OutputChip } from "./ValueChip"

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
 * another value when clicked (see ValueChip, lib/outputOverrides.ts).
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
                        outputRef={part.ref}
                        output={part.output}
                        override={part.override}
                        disabled={disabled}
                        onEnter={(entered, sensitive) =>
                          onOverride(part.ref, sensitive ? sensitiveOutput(entered) : entered)
                        }
                        onReset={() => onReset(part.ref)}
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
