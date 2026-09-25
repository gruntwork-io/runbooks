import { CircleQuestionMark, CheckCircle, AlertTriangle, XCircle, Loader2 } from "lucide-react"
import { ScriptBlock, type ScriptBlockProps, type ScriptBlockVariant } from "@/components/mdx/_shared/components/ScriptBlock"
import { makeStatusStyles } from "@/components/mdx/_shared/lib/statusStyles"
import type { ExecutionStatus } from "@/components/mdx/_shared/types"

const CHECK_VARIANT: ScriptBlockVariant = {
  componentType: 'check',
  name: 'Check',
  runLabel: 'Check',
  defaultRunningMessage: 'Checking...',
  fileName: 'Check Script',
  fileErrorHeading: 'Check Component Error',
  renderErrorLabel: 'Script render error',
  missingInputsSubject: 'check script',
  showScriptMetadata: false,
  showPendingPlaceholder: false,
  instructionIcon: CircleQuestionMark,
  instructionInlineTitle: 'Run this check:',
  instructionPathTitle: 'Run this check script:',
  statusStyles: makeStatusStyles<ExecutionStatus>({
    container: {
      success: 'bg-success-muted border-success/30',
      warn: 'bg-warning-muted border-warning/30',
      fail: 'bg-destructive-muted border-destructive/30',
      running: 'bg-info-muted border-info/40',
      pending: 'bg-muted border-border',
    },
    icon: {
      success: CheckCircle,
      warn: AlertTriangle,
      fail: XCircle,
      running: Loader2,
      pending: CircleQuestionMark,
    },
    iconColor: {
      success: 'text-success',
      warn: 'text-warning',
      fail: 'text-destructive',
      running: 'text-info',
      pending: 'text-muted-foreground',
    },
  }),
}

type CheckProps = Omit<ScriptBlockProps, 'variant'>

function Check(props: CheckProps) {
  return <ScriptBlock {...props} variant={CHECK_VARIANT} />
}

// Set displayName for React DevTools and component detection
Check.displayName = 'Check';

export default Check;
