import { FileKey, ExternalLink, Terminal, type LucideIcon } from "lucide-react"
import type { GoogleAuthMethod } from "../types"

interface AuthTabsProps {
  methods: readonly GoogleAuthMethod[]
  authMethod: GoogleAuthMethod
  setAuthMethod: (method: GoogleAuthMethod) => void
  /**
   * True when no OAuth client is configured yet (the hook's `oauthUnavailable`).
   * The tab stays selectable: OAuthFlow offers a Desktop client JSON picker.
   */
  oauthUnavailable?: boolean | undefined
}

const TABS: Record<GoogleAuthMethod, { label: string; icon: LucideIcon }> = {
  service_account: { label: "Service Account Key", icon: FileKey },
  oauth: { label: "Google Sign-In", icon: ExternalLink },
  gcloud: { label: "gcloud Config", icon: Terminal },
}

const NEEDS_OAUTH_CLIENT_TITLE = "Choose a Desktop OAuth client JSON to enable Google Sign-In"

/**
 * The three GoogleAuth methods, mapped 1:1 onto AwsAuth's three tabs:
 * `service_account` <- Static Credentials, `oauth` <- AWS SSO,
 * `gcloud` <- Local Profile. The accent is `info` (blue) rather than AwsAuth's
 * AWS-orange `warning`, matching GitAuth.
 */
export function AuthTabs({ methods, authMethod, setAuthMethod, oauthUnavailable }: AuthTabsProps) {
  if (methods.length < 2) return null
  return (
    <div className="flex gap-1 mb-4 border-b border-info/30">
      {methods.map((method) => (
        <MethodTab
          key={method}
          method={method}
          isActive={method === authMethod}
          needsOAuthClient={method === "oauth" && oauthUnavailable === true}
          onSelect={() => setAuthMethod(method)}
        />
      ))}
    </div>
  )
}

interface MethodTabProps {
  method: GoogleAuthMethod
  isActive: boolean
  needsOAuthClient: boolean
  onSelect: () => void
}

function MethodTab({ method, isActive, needsOAuthClient, onSelect }: MethodTabProps) {
  const { label, icon: Icon } = TABS[method]
  const emphasis = isActive
    ? "text-info border-b-2 border-info -mb-px"
    : "text-muted-foreground hover:text-foreground"
  return (
    <button
      type="button"
      onClick={onSelect}
      title={needsOAuthClient ? NEEDS_OAUTH_CLIENT_TITLE : undefined}
      className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${emphasis}`}
    >
      <Icon className="size-4 inline mr-2" />
      {label}
      {needsOAuthClient && <span className="ml-2 text-xs font-normal">(needs OAuth client)</span>}
    </button>
  )
}
