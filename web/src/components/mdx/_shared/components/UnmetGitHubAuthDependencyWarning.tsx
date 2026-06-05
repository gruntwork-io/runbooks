import { AlertTriangle } from 'lucide-react'
import type { UnmetGitHubAuthDependency } from '../hooks/useScriptExecution'

interface UnmetGitHubAuthDependencyWarningProps {
  unmetGitHubAuthDependency: UnmetGitHubAuthDependency | null
}

/**
 * Displays a warning when a block requires credentials from an auth block
 * (githubAuthId GitHubAuth, or a provider-agnostic gitAuthId GitAuth) that
 * hasn't been authenticated yet. Wording is provider-neutral because the
 * referenced block may be GitHub or GitLab.
 */
export const UnmetGitHubAuthDependencyWarning: React.FC<UnmetGitHubAuthDependencyWarningProps> = ({
  unmetGitHubAuthDependency
}) => {
  if (!unmetGitHubAuthDependency) return null

  return (
    <div className="mb-3 text-sm text-warning-foreground flex items-start gap-2">
      <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
      <div>
        <strong>Waiting for git authentication:</strong>{' '}
        <code className="bg-warning-muted px-1 rounded text-xs">{unmetGitHubAuthDependency.blockId}</code>
        <div className="text-xs mt-1 text-warning-foreground">
          Authenticate with the referenced authentication block first.
        </div>
      </div>
    </div>
  )
}
