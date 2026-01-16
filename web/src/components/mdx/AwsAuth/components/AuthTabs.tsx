import { KeyRound, ExternalLink, User } from "lucide-react"
import type { AuthMethod } from "../types"

interface AuthTabsProps {
  authMethod: AuthMethod
  setAuthMethod: (method: AuthMethod) => void
}

export function AuthTabs({ authMethod, setAuthMethod }: AuthTabsProps) {
  return (
    <div className="flex gap-1 mb-4 border-b border-amber-200">
      <button
        onClick={() => setAuthMethod('credentials')}
        className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
          authMethod === 'credentials'
            ? 'text-amber-700 border-b-2 border-amber-500 -mb-px'
            : 'text-gray-500 hover:text-gray-700'
        }`}
      >
        <KeyRound className="size-4 inline mr-2" />
        Static Credentials
      </button>
      <button
        onClick={() => setAuthMethod('sso')}
        className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
          authMethod === 'sso'
            ? 'text-amber-700 border-b-2 border-amber-500 -mb-px'
            : 'text-gray-500 hover:text-gray-700'
        }`}
      >
        <ExternalLink className="size-4 inline mr-2" />
        AWS SSO
      </button>
      <button
        onClick={() => setAuthMethod('profile')}
        className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
          authMethod === 'profile'
            ? 'text-amber-700 border-b-2 border-amber-500 -mb-px'
            : 'text-gray-500 hover:text-gray-700'
        }`}
      >
        <User className="size-4 inline mr-2" />
        Local Profile
      </button>
    </div>
  )
}
