import { CircleQuestionMark, CheckCircle, AlertTriangle, XCircle, Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import { ScriptBlock, type ScriptBlockVariant } from "@/components/mdx/_shared/components/ScriptBlock"
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

interface CheckProps {
  id: string
  title?: string
  description?: string
  path?: string
  command?: string
  /** Reference to one or more Inputs by ID for template variable substitution. When multiple IDs are provided, variables are merged in order (later IDs override earlier ones). */
  inputsId?: string | string[]
  /** Reference to an AwsAuth block by ID for AWS credentials. The credentials will be passed as environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION). */
  awsAuthId?: string
  /** Reference to a GitHubAuth block by ID for GitHub credentials. The credentials will be passed as environment variables (GITHUB_TOKEN, GITHUB_USER). */
  githubAuthId?: string
  /** Reference to a GitAuth block by ID (GitHub or GitLab). The block's credentials (GITHUB_TOKEN/GITHUB_USER or GITLAB_TOKEN/GITLAB_USER) will be passed as environment variables. */
  gitAuthId?: string
  successMessage?: string
  warnMessage?: string
  failMessage?: string
  runningMessage?: string
  children?: ReactNode // For inline Inputs component
  /** Whether to use PTY (pseudo-terminal) for script execution. Defaults to true. Set to false to use pipes instead, which may be needed for scripts that don't work well with PTY or when simpler output handling is preferred. */
  usePty?: boolean
  /** Per-execution timeout in milliseconds. When omitted, the executor's default timeout (5 minutes) applies. */
  timeoutMs?: number
}

function Check(props: CheckProps) {
  return <ScriptBlock {...props} variant={CHECK_VARIANT} />
}

// Set displayName for React DevTools and component detection
Check.displayName = 'Check';

export default Check;
