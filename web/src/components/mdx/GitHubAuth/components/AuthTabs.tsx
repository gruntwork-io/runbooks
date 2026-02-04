import { KeyRound, ExternalLink } from "lucide-react"
import type { GitHubAuthMethod } from "../types"

interface AuthTabsProps {
  authMethod: GitHubAuthMethod
  setAuthMethod: (method: GitHubAuthMethod) => void
}

export function AuthTabs({ authMethod, setAuthMethod }: AuthTabsProps) {
  return (
    <div className="flex gap-1 mb-4 border-b border-violet-200">
      <button
        type="button"
        onClick={() => setAuthMethod('oauth')}
        className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
          authMethod === 'oauth'
            ? 'text-violet-700 border-b-2 border-violet-500 -mb-px'
            : 'text-gray-500 hover:text-gray-700'
        }`}
      >
        <ExternalLink className="size-4 inline mr-2" />
        Sign in with GitHub
      </button>
      <button
        type="button"
        onClick={() => setAuthMethod('pat')}
        className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer ${
          authMethod === 'pat'
            ? 'text-violet-700 border-b-2 border-violet-500 -mb-px'
            : 'text-gray-500 hover:text-gray-700'
        }`}
      >
        <KeyRound className="size-4 inline mr-2" />
        Personal Access Token
      </button>
    </div>
  )
}
