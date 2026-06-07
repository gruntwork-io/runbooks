import { SquareTerminal, CheckCircle, XCircle, Loader2, AlertTriangle } from "lucide-react"
import type { ReactNode } from "react"
import { ScriptBlock, type ScriptBlockVariant } from "@/components/mdx/_shared/components/ScriptBlock"
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

interface CommandProps {
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
  failMessage?: string
  runningMessage?: string
  children?: ReactNode // For inline Inputs component
  /** Whether to use PTY (pseudo-terminal) for script execution. Defaults to true. Set to false to use pipes instead, which may be needed for scripts that don't work well with PTY or when simpler output handling is preferred. */
  usePty?: boolean
  /** Per-execution timeout in milliseconds. When omitted, the executor's default timeout (5 minutes) applies. */
  timeoutMs?: number
}

function Command(props: CommandProps) {
  return <ScriptBlock {...props} variant={COMMAND_VARIANT} />
}

// Set displayName for React DevTools and component detection
Command.displayName = 'Command';

export default Command;
