import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"

interface CustomOAuthWarningProps {
  clientId: string
  onUseDefault: () => void
  onContinue: () => void
}

export function CustomOAuthWarning({ clientId, onUseDefault, onContinue }: CustomOAuthWarningProps) {
  // Truncate client ID for display
  const displayClientId = clientId.length > 20 
    ? `${clientId.slice(0, 12)}...${clientId.slice(-4)}`
    : clientId

  return (
    <div className="bg-amber-50 border border-amber-300 rounded-md p-4 mb-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="size-5 text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <h4 className="text-sm font-semibold text-amber-800 mb-2">
            Custom OAuth App
          </h4>
          <p className="text-sm text-amber-700 mb-3">
            This runbook uses a custom GitHub OAuth app, not the default Gruntwork Runbooks app.
          </p>
          <div className="bg-amber-100/50 rounded px-2 py-1 mb-3 font-mono text-xs text-amber-800">
            Client ID: {displayClientId}
          </div>
          <p className="text-sm text-amber-700 mb-4">
            Only proceed if you trust the source of this runbook. The token will stay on your machine, 
            but you'll be authorizing a third-party app.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onUseDefault}
              className="border-amber-400 text-amber-700 hover:bg-amber-100"
            >
              Use default app instead
            </Button>
            <Button
              size="sm"
              onClick={onContinue}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              Continue anyway
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
