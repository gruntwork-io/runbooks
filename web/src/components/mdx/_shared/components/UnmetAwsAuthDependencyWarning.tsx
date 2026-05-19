import { AlertTriangle } from 'lucide-react'
import type { UnmetAwsAuthDependency } from '../hooks/useScriptExecution'

interface UnmetAwsAuthDependencyWarningProps {
  unmetAwsAuthDependency: UnmetAwsAuthDependency | null
}

/**
 * Displays a warning when a block requires AWS credentials from an AwsAuth block
 * that hasn't been authenticated yet.
 */
export const UnmetAwsAuthDependencyWarning: React.FC<UnmetAwsAuthDependencyWarningProps> = ({
  unmetAwsAuthDependency
}) => {
  if (!unmetAwsAuthDependency) return null

  return (
    <div className="mb-3 text-sm text-warning-foreground flex items-start gap-2">
      <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
      <div>
        <strong>Waiting for AWS authentication:</strong>{' '}
        <code className="bg-warning-muted px-1 rounded text-xs">{unmetAwsAuthDependency.blockId}</code>
        <div className="text-xs mt-1 text-warning-foreground">
          Authenticate with the referenced AwsAuth block first.
        </div>
      </div>
    </div>
  )
}
