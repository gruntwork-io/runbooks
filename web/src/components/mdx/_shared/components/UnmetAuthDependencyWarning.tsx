import { AlertTriangle } from 'lucide-react'
import type { UnmetAuthDependency } from '../hooks/useScriptExecution'

interface UnmetAuthDependencyWarningProps {
  dependency: UnmetAuthDependency | null
  /** Bold lead-in, e.g. "Waiting for AWS authentication:". */
  heading: string
  /** Secondary hint line telling the user which block to authenticate. */
  hint: string
}

/**
 * Displays a warning when a block requires credentials from an auth block
 * (AwsAuth, GitHubAuth, or a provider-agnostic GitAuth) that hasn't been
 * authenticated yet. The heading/hint are supplied by the caller so the
 * wording can be provider-specific (or provider-neutral for git).
 */
export const UnmetAuthDependencyWarning: React.FC<UnmetAuthDependencyWarningProps> = ({
  dependency,
  heading,
  hint,
}) => {
  if (!dependency) return null

  return (
    <div className="mb-3 text-sm text-warning-foreground flex items-start gap-2">
      <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
      <div>
        <strong>{heading}</strong>{' '}
        <code className="bg-warning-muted px-1 rounded text-xs">{dependency.blockId}</code>
        <div className="text-xs mt-1 text-warning-foreground">{hint}</div>
      </div>
    </div>
  )
}
