import { KeyRound, ExternalLink } from "lucide-react"
import type { GitAuthMethod } from "../types"
import type { ProviderConfig } from "../providers"

interface AuthTabsProps {
  authMethod: GitAuthMethod
  setAuthMethod: (method: GitAuthMethod) => void
  provider: ProviderConfig
  /** Disable the OAuth tab when the host is unreachable (§2.0) — the device
   *  flow would hit the same TLS/network wall. */
  oauthDisabled?: boolean
  oauthDisabledReason?: string
}

export function AuthTabs({ authMethod, setAuthMethod, provider, oauthDisabled = false, oauthDisabledReason }: AuthTabsProps) {
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
          onClick={() => !oauthDisabled && setAuthMethod('oauth')}
          disabled={oauthDisabled}
          title={oauthDisabled ? oauthDisabledReason : undefined}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            oauthDisabled
              ? 'text-muted-foreground/50 cursor-not-allowed'
              : authMethod === 'oauth'
                ? 'text-info border-b-2 border-info -mb-px cursor-pointer'
                : 'text-muted-foreground hover:text-foreground cursor-pointer'
          }`}
        >
          <ExternalLink className="size-4 inline mr-2" />
          Sign in with {provider.label}
          {oauthDisabled && oauthDisabledReason && (
            <span className="ml-2 text-xs font-normal">({oauthDisabledReason})</span>
          )}
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
