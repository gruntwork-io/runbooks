import { useContext, useEffect, useId, useRef, type ReactNode } from "react"
import { AlertCircle } from "lucide-react"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { issueAnchor } from "@/contexts/ErrorReportingContext.types"
import { ProgressRegistryContext } from "@/contexts/RunbookProgressContext.types"
import { usePageBlocks } from "@/contexts/ComponentIdRegistry"
import { useAllOutputs } from "@/contexts/useRunbook"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { useAgentBlock, useAgentPresence } from "@/contexts/useAgentBridge"
import { revealOutput } from "@/lib/outputValues"
import { normalizeBlockId } from "@/lib/utils"
import {
  describeShowWhenOutput,
  parseShowWhenOutput,
  showWhenOutputHolds,
} from "../../../../../src/domain/exec/showWhenOutput"

interface ShowWhenProps {
  /** The block and output to read, as "<block_id>.<OUTPUT_NAME>". */
  output?: string
  /** Show the content while the output is this value. */
  equals?: string
  /** Show the content while the output is anything but this value. */
  notEquals?: string
  /** Show the content while the output is one of these values. */
  in?: string[]
  /** What the content does until the output exists: "show" (the default) or "hide". */
  whenUnknown?: "show" | "hide"
  children?: ReactNode
}

/**
 * Shows its content only while another block's output has a given value, and
 * follows the output as it changes. Hidden content stays mounted, so the
 * blocks in it keep their ids, state and outputs, but they aren't steps of
 * the runbook's progress while hidden.
 */
export function ShowWhen({ children, ...props }: ShowWhenProps) {
  const parsed = parseShowWhenOutput(props)
  const condition = parsed.ok ? parsed.condition : null
  const { isOnPage } = usePageBlocks()
  const allOutputs = useAllOutputs()
  const { enabled: instructionMode } = useInstructionMode()
  const parentRegistry = useContext(ProgressRegistryContext)
  const { reportError, clearError } = useErrorReporting()
  const errorId = useId()

  const configError = !parsed.ok
    ? parsed.error
    : condition && isOnPage(condition.blockId) === false
      ? `<ShowWhen> reads the output "${condition.output}" of block "${condition.blockId}", but no block has that id.`
      : null
  useEffect(() => {
    if (!configError) return
    reportError({
      componentId: errorId,
      componentType: "ShowWhen",
      severity: "error",
      message: configError,
    })
    return () => clearError(errorId)
  }, [configError, errorId, reportError, clearError])

  const raw = condition
    ? allOutputs[normalizeBlockId(condition.blockId)]?.values[condition.output]
    : undefined
  const value = raw === undefined ? undefined : revealOutput(raw)
  // Nothing runs in instruction mode, so no output can decide, and the reader
  // sees every case, each with its condition.
  const shown =
    !condition || configError !== null || instructionMode || showWhenOutputHolds(condition, value)

  const contentRef = useRef<HTMLDivElement>(null)
  const agentId = `show-when-${errorId.replace(/[^a-zA-Z0-9]/g, "")}`
  useAgentPresence(agentId, "ShowWhen", contentRef)
  useAgentBlock(agentId, {
    type: "ShowWhen",
    status: () => "info",
    blockedBy: () => (configError ? [configError] : []),
    detail: () => ({
      state: {
        condition: condition ? describeShowWhenOutput(condition) : undefined,
        outputKnown: value !== undefined,
        shown,
      },
    }),
  })

  return (
    <>
      {configError && (
        <div
          {...issueAnchor(errorId)}
          className="runbook-block rounded-md border p-3 text-sm flex items-start gap-2 mb-5 bg-destructive-muted border-destructive/30 text-destructive"
        >
          <AlertCircle className="size-4 mt-0.5 flex-shrink-0" />
          <div>
            <div className="text-md font-bold mb-1">Invalid ShowWhen</div>
            <p>{configError}</p>
          </div>
        </div>
      )}
      {instructionMode && condition && !configError && (
        <p className="text-sm italic text-muted-foreground mb-2">
          Only when {describeShowWhenOutput(condition)}:
        </p>
      )}
      <div
        ref={contentRef}
        data-testid="show-when"
        hidden={!shown}
        className={shown ? "contents" : undefined}
      >
        {/* A hidden step isn't one the user can do, so it leaves the progress count. */}
        <ProgressRegistryContext.Provider value={shown ? parentRegistry : undefined}>
          {children}
        </ProgressRegistryContext.Provider>
      </div>
    </>
  )
}
