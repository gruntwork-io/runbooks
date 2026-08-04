import { FileKey, ExternalLink, Terminal } from "lucide-react"
import type { GoogleAuthMethod } from "../types"

interface AuthTabsProps {
  authMethod: GoogleAuthMethod
  setAuthMethod: (method: GoogleAuthMethod) => void
  /**
   * True when no OAuth client is configured yet (the hook's `oauthUnavailable`).
   * The tab stays selectable — OAuthFlow offers a Desktop client JSON picker.
   */
  oauthUnavailable?: boolean
}

/**
 * The three GoogleAuth methods, mapped 1:1 onto AwsAuth's three tabs:
 * `service_account` <- Static Credentials, `oauth` <- AWS SSO,
 * `gcloud` <- Local Profile. The accent is `info` (blue) rather than AwsAuth's
 * AWS-orange `warning`, matching GitAuth.
 */
export function AuthTabs({ authMethod, setAuthMethod, oauthUnavailable = false }: AuthTabsProps) {
  return (
    <div className="flex gap-1 mb-4 border-b border-info/30">
      <button
        type="button"
        onClick={() => setAuthMethod('service_account')}
        className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
          authMethod === 'service_account'
            ? 'text-info border-b-2 border-info -mb-px'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <FileKey className="size-4 inline mr-2" />
        Service Account Key
      </button>
      <button
        type="button"
        onClick={() => setAuthMethod('oauth')}
        title={
          oauthUnavailable
            ? 'Choose a Desktop OAuth client JSON to enable Google Sign-In'
            : undefined
        }
        className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
          authMethod === 'oauth'
            ? 'text-info border-b-2 border-info -mb-px'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <ExternalLink className="size-4 inline mr-2" />
        Google Sign-In
        {oauthUnavailable && (
          <span className="ml-2 text-xs font-normal">(needs OAuth client)</span>
        )}
      </button>
      <button
        type="button"
        onClick={() => setAuthMethod('gcloud')}
        className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
          authMethod === 'gcloud'
            ? 'text-info border-b-2 border-info -mb-px'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <Terminal className="size-4 inline mr-2" />
        gcloud Config
      </button>
    </div>
  )
}
