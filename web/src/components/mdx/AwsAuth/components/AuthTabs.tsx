import { KeyRound, ExternalLink, User } from "lucide-react"
import type { AuthMethod } from "../types"

interface AuthTabsProps {
  authMethod: AuthMethod
  setAuthMethod: (method: AuthMethod) => void
}

export function AuthTabs({ authMethod, setAuthMethod }: AuthTabsProps) {
  return (
    <div className="flex gap-1 mb-4 border-b border-warning/30">
      <button
        onClick={() => setAuthMethod('credentials')}
        className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
          authMethod === 'credentials'
            ? 'text-warning border-b-2 border-warning -mb-px'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <KeyRound className="size-4 inline mr-2" />
        Static Credentials
      </button>
      <button
        onClick={() => setAuthMethod('sso')}
        className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
          authMethod === 'sso'
            ? 'text-warning border-b-2 border-warning -mb-px'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <ExternalLink className="size-4 inline mr-2" />
        AWS SSO
      </button>
      <button
        onClick={() => setAuthMethod('profile')}
        className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
          authMethod === 'profile'
            ? 'text-warning border-b-2 border-warning -mb-px'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <User className="size-4 inline mr-2" />
        Local Profile
      </button>
    </div>
  )
}
