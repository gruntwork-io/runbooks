import { Flag, PartyPopper, AlertTriangle, XCircle, Loader2 } from "lucide-react"
import { ScriptBlock, type ScriptBlockProps, type ScriptBlockVariant } from "@/components/mdx/_shared/components/ScriptBlock"
import { makeStatusStyles } from "@/components/mdx/_shared/lib/statusStyles"
import type { ExecutionStatus } from "@/components/mdx/_shared/types"
import { celebrate } from "./celebrate"

const FINISH_VARIANT: ScriptBlockVariant = {
  // A final check behaves like a <Check>: exit 2 is a warning, not a finish.
  componentType: 'check',
  name: 'Finish',
  runLabel: 'Finish',
  defaultRunningMessage: 'Running the final check...',
  fileName: 'Final Check Script',
  fileErrorHeading: 'Finish Component Error',
  renderErrorLabel: 'Script render error',
  missingInputsSubject: 'final check',
  showScriptMetadata: false,
  showPendingPlaceholder: false,
  instructionIcon: Flag,
  instructionInlineTitle: 'Run this final check:',
  instructionPathTitle: 'Run this final check script:',
  scriptOptional: true,
  // Children are the next steps, shown once finished, so they can't be an <Inputs>.
  inlineInputs: false,
  statusStyles: makeStatusStyles<ExecutionStatus>({
    container: {
      success: 'bg-success-muted border-success/30',
      warn: 'bg-warning-muted border-warning/30',
      fail: 'bg-destructive-muted border-destructive/30',
      running: 'bg-info-muted border-info/40',
      pending: 'bg-muted border-border',
    },
    icon: {
      success: PartyPopper,
      warn: AlertTriangle,
      fail: XCircle,
      running: Loader2,
      pending: Flag,
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

type FinishProps = Omit<ScriptBlockProps, 'variant' | 'successContent' | 'onComplete'>

/**
 * Marks the end of a runbook. Clicking Finish runs the optional final check
 * (`command` or `path`, like a <Check>); once the runbook is finished it
 * celebrates and shows the author's next steps (the block's children).
 */
function Finish({
  title = 'Finish this runbook',
  successMessage = 'You finished this runbook!',
  failMessage = 'The final check failed. Check the logs, fix the problem, and run it again.',
  children,
  ...props
}: FinishProps) {
  // Markdown lists lose their bullets inside a block (App.css resets them for
  // block chrome), so give the author's next steps theirs back, and keep a
  // leading heading's top margin from pushing them down.
  const nextSteps = children ? (
    <div className="space-y-2 text-foreground [&>:first-child]:mt-0 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6">
      {children}
    </div>
  ) : undefined

  return (
    <ScriptBlock
      {...props}
      title={title}
      successMessage={successMessage}
      failMessage={failMessage}
      successContent={nextSteps}
      onComplete={celebrate}
      variant={FINISH_VARIANT}
    />
  )
}

// Set displayName for React DevTools and component detection
Finish.displayName = 'Finish';

export default Finish;
