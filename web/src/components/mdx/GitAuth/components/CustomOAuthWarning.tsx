import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"

interface CustomOAuthWarningProps {
  clientId: string
  onUseDefault: () => void
  onContinue: () => void
}

export function CustomOAuthWarning({ clientId, onUseDefault, onContinue }: CustomOAuthWarningProps) {
  const displayClientId = clientId.length > 20
    ? `${clientId.slice(0, 12)}...${clientId.slice(-4)}`
    : clientId

  return (
    <div className="bg-warning-muted border border-warning/30 rounded-md p-4 mb-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="size-5 text-warning flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <h4 className="text-sm font-semibold text-warning-foreground mb-2">
            Custom OAuth App
          </h4>
          <p className="text-sm text-warning-foreground mb-3">
            This runbook uses a custom GitHub OAuth app, not the default Gruntwork Runbooks app.
          </p>
          <div className="bg-warning-muted/50 rounded px-2 py-1 mb-3 font-mono text-xs text-warning-foreground">
            Client ID: {displayClientId}
          </div>
          <p className="text-sm text-warning-foreground mb-4">
            Only proceed if you trust the source of this runbook. The token will stay on your machine, 
            but you'll be authorizing a third-party app.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onUseDefault}
              className="border-warning/30 text-warning-foreground hover:bg-warning-muted"
            >
              Use default app instead
            </Button>
            <Button
              size="sm"
              onClick={onContinue}
              className="bg-warning hover:bg-warning/90 text-white"
            >
              Continue anyway
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
