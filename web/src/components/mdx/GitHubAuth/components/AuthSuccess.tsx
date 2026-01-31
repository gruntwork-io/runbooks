import { Button } from "@/components/ui/button"
import type { GitHubUserInfo } from "../types"

interface AuthSuccessProps {
  userInfo: GitHubUserInfo
  prefillSource?: 'env' | 'outputs' | 'static' | null
  onReAuthenticate?: () => void
  onManualAuth?: () => void
}

export function AuthSuccess({ userInfo, prefillSource, onReAuthenticate, onManualAuth }: AuthSuccessProps) {
  return (
    <div className="mb-4">
      <div className="text-green-700 font-semibold text-sm mb-2 flex items-center gap-2">
        <span>✓ Authenticated to GitHub</span>
        {prefillSource && (
          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-normal">
            {prefillSource === 'env' && 'From Environment'}
            {prefillSource === 'outputs' && 'From Command Output'}
            {prefillSource === 'static' && 'Pre-configured'}
          </span>
        )}
      </div>
      <div className="bg-green-100/50 rounded p-3 text-sm">
        <div className="flex items-center gap-3">
          {userInfo.avatarUrl && (
            <img 
              src={userInfo.avatarUrl} 
              alt={userInfo.login}
              className="w-10 h-10 rounded-full border border-green-200"
            />
          )}
          <div>
            <div className="text-gray-700 font-medium">
              {userInfo.name || userInfo.login}
            </div>
            <div className="text-gray-500 text-xs">
              @{userInfo.login}
              {userInfo.email && ` • ${userInfo.email}`}
            </div>
          </div>
        </div>
      </div>
      {/* Action buttons */}
      {(onReAuthenticate || onManualAuth) && (
        <div className="mt-3 flex items-center gap-3">
          {onReAuthenticate && (
            <Button 
              variant="outline" 
              size="sm" 
              onClick={onReAuthenticate}
            >
              Re-authenticate
            </Button>
          )}
          {onManualAuth && (
            <Button 
              variant="link" 
              size="sm" 
              onClick={onManualAuth}
            >
              Authenticate manually
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
