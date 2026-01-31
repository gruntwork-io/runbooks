import { AlertTriangle } from 'lucide-react'
import type { UnmetGitHubAuthDependency } from '../hooks/useScriptExecution'

interface UnmetGitHubAuthDependencyWarningProps {
  unmetGitHubAuthDependency: UnmetGitHubAuthDependency | null
}

/**
 * Displays a warning when a block requires GitHub credentials from a GitHubAuth block
 * that hasn't been authenticated yet.
 */
export const UnmetGitHubAuthDependencyWarning: React.FC<UnmetGitHubAuthDependencyWarningProps> = ({
  unmetGitHubAuthDependency
}) => {
  if (!unmetGitHubAuthDependency) return null

  return (
    <div className="mb-3 text-sm text-yellow-700 flex items-start gap-2">
      <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
      <div>
        <strong>Waiting for GitHub authentication:</strong>{' '}
        <code className="bg-yellow-100 px-1 rounded text-xs">{unmetGitHubAuthDependency.blockId}</code>
        <div className="text-xs mt-1 text-yellow-600">
          Authenticate with the referenced GitHubAuth block first.
        </div>
      </div>
    </div>
  )
}
