import { KeyRound, ExternalLink } from "lucide-react"
import type { GitAuthMethod } from "../types"
import type { ProviderConfig } from "../providers"

interface AuthTabsProps {
  authMethod: GitAuthMethod
  setAuthMethod: (method: GitAuthMethod) => void
  provider: ProviderConfig
}

export function AuthTabs({ authMethod, setAuthMethod, provider }: AuthTabsProps) {
  // With a single manual method (e.g. GitLab → PAT only) there is nothing to
  // choose, so the tab bar collapses to the bare form.
  if (provider.manualMethods.length <= 1) {
    return null
  }

  return (
    <div className="flex gap-1 mb-4 border-b border-border">
      {provider.supportsOAuth && (
        <button
          type="button"
          onClick={() => setAuthMethod('oauth')}
          className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
            authMethod === 'oauth'
              ? 'text-info border-b-2 border-info -mb-px'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <ExternalLink className="size-4 inline mr-2" />
          Sign in with {provider.label}
        </button>
      )}
      <button
        type="button"
        onClick={() => setAuthMethod('pat')}
        className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
          authMethod === 'pat'
            ? 'text-info border-b-2 border-info -mb-px'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <KeyRound className="size-4 inline mr-2" />
        Personal Access Token
      </button>
    </div>
  )
}
