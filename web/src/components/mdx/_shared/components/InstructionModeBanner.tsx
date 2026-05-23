import { ListChecks } from 'lucide-react'
import { useInstructionMode } from '@/contexts/useInstructionMode'
import { INSTRUCTION_MODE_BANNER_TEXT } from '@/contexts/InstructionModeContext.types'

/**
 * Persistent banner shown at the top of a runbook while instruction mode is on,
 * explaining why the action buttons are gone (PRD §6 / spec §6.2). Renders
 * nothing when the mode is off, so the interactive view is byte-for-byte
 * unchanged.
 */
export function InstructionModeBanner() {
  const { enabled } = useInstructionMode()
  if (!enabled) return null

  return (
    <div
      data-testid="instruction-mode-banner"
      className="flex items-start gap-2 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground"
    >
      <ListChecks className="size-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
      <span>{INSTRUCTION_MODE_BANNER_TEXT}</span>
    </div>
  )
}
