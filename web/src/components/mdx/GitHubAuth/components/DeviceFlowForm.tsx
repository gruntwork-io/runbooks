import { Loader2, ExternalLink, Copy, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useState } from "react"
import type { GitHubAuthStatus, DeviceFlowResponse } from "../types"

interface DeviceFlowFormProps {
  authStatus: GitHubAuthStatus
  deviceFlow: DeviceFlowResponse | null
  onStart: () => void
  onCancel: () => void
}

export function DeviceFlowForm({
  authStatus,
  deviceFlow,
  onStart,
  onCancel,
}: DeviceFlowFormProps) {
  const [copied, setCopied] = useState(false)
  const isAuthenticating = authStatus === 'authenticating'

  const handleCopyCode = async () => {
    if (deviceFlow?.userCode) {
      await navigator.clipboard.writeText(deviceFlow.userCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  if (deviceFlow) {
    return (
      <div className="space-y-4">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="text-center space-y-3">
            <p className="text-sm text-blue-800">
              Enter this code on GitHub:
            </p>
            <div className="flex items-center justify-center gap-2">
              <code className="text-2xl font-mono font-bold tracking-wider bg-white px-4 py-2 rounded border border-blue-200">
                {deviceFlow.userCode}
              </code>
              <button
                onClick={handleCopyCode}
                className="p-2 hover:bg-blue-100 rounded transition-colors"
                title="Copy code"
              >
                {copied ? (
                  <Check className="size-5 text-green-600" />
                ) : (
                  <Copy className="size-5 text-blue-600" />
                )}
              </button>
            </div>
            <p className="text-xs text-blue-600">
              A new tab should have opened. If not,{" "}
              <a
                href={deviceFlow.verificationUri}
                target="_blank"
                rel="noopener noreferrer"
                className="underline inline-flex items-center gap-1"
              >
                click here <ExternalLink className="size-3" />
              </a>
            </p>
          </div>
        </div>

        <div className="flex items-center justify-center gap-2 text-sm text-gray-600">
          <Loader2 className="size-4 animate-spin" />
          Waiting for authorization...
        </div>

        <Button variant="outline" onClick={onCancel} className="w-full">
          Cancel
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Use GitHub's device flow to authenticate without entering a token directly.
        You'll be redirected to GitHub to authorize this application.
      </p>

      <Button
        onClick={onStart}
        disabled={isAuthenticating}
        className="w-full"
      >
        {isAuthenticating ? (
          <>
            <Loader2 className="size-4 mr-2 animate-spin" />
            Starting...
          </>
        ) : (
          <>
            <ExternalLink className="size-4 mr-2" />
            Authorize with GitHub
          </>
        )}
      </Button>
    </div>
  )
}
