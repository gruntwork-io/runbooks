import { SquareTerminal, CheckCircle, XCircle, Loader2, AlertTriangle } from "lucide-react"
import { ScriptBlock, type ScriptBlockProps, type ScriptBlockVariant } from "@/components/mdx/_shared/components/ScriptBlock"
import { makeStatusStyles } from "@/components/mdx/_shared/lib/statusStyles"
import type { ExecutionStatus } from "@/components/mdx/_shared/types"

const COMMAND_VARIANT: ScriptBlockVariant = {
  componentType: 'command',
  name: 'Command',
  runLabel: 'Run',
  defaultRunningMessage: 'Running...',
  fileName: 'Command Script',
  fileErrorHeading: 'Command Component Error',
  renderErrorLabel: 'Command render error',
  missingInputsSubject: 'command',
  showScriptMetadata: true,
  showPendingPlaceholder: true,
  instructionInlineTitle: 'Run this command:',
  instructionPathTitle: 'Run this script:',
  statusStyles: makeStatusStyles<ExecutionStatus>({
    container: {
      success: 'bg-success-muted border-success/30',
      fail: 'bg-destructive-muted border-destructive/30',
      running: 'bg-info-muted border-info/40',
      pending: 'bg-muted border-border',
      warn: 'bg-warning-muted border-warning/30', // Should not happen for Command, but include for type safety
    },
    icon: {
      success: CheckCircle,
      fail: XCircle,
      running: Loader2,
      pending: SquareTerminal, // Terminal icon for pending state
      warn: AlertTriangle, // Should not happen for Command
    },
    iconColor: {
      success: 'text-success',
      fail: 'text-destructive',
      running: 'text-info',
      pending: 'text-muted-foreground',
      warn: 'text-warning', // Should not happen for Command
    },
  }),
}

type CommandProps = Omit<ScriptBlockProps, 'variant' | 'warnMessage'>

function Command(props: CommandProps) {
  return <ScriptBlock {...props} variant={COMMAND_VARIANT} />
}

// Set displayName for React DevTools and component detection
Command.displayName = 'Command';

export default Command;
