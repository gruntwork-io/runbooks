import { Loader2, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DefaultRegionPicker } from "./DefaultRegionPicker"
import type { AuthStatus } from "../types"

interface CredentialsFormProps {
  authStatus: AuthStatus
  accessKeyId: string
  setAccessKeyId: (value: string) => void
  secretAccessKey: string
  setSecretAccessKey: (value: string) => void
  sessionToken: string
  setSessionToken: (value: string) => void
  selectedDefaultRegion: string
  setSelectedDefaultRegion: (value: string) => void
  showSecretKey: boolean
  setShowSecretKey: (value: boolean) => void
  showSessionToken: boolean
  setShowSessionToken: (value: boolean) => void
  onSubmit: () => void
}

export function CredentialsForm({
  authStatus,
  accessKeyId,
  setAccessKeyId,
  secretAccessKey,
  setSecretAccessKey,
  sessionToken,
  setSessionToken,
  selectedDefaultRegion,
  setSelectedDefaultRegion,
  showSecretKey,
  setShowSecretKey,
  showSessionToken,
  setShowSessionToken,
  onSubmit,
}: CredentialsFormProps) {
  const isAuthenticating = authStatus === 'authenticating'

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Access Key ID <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={accessKeyId}
          onChange={(e) => setAccessKeyId(e.target.value)}
          placeholder="AKIAIOSFODNN7EXAMPLE"
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono text-sm placeholder-gray-400"
          disabled={isAuthenticating}
        />
      </div>
      
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Secret Access Key <span className="text-red-500">*</span>
        </label>
        <div className="relative">
          <input
            type={showSecretKey ? 'text' : 'password'}
            value={secretAccessKey}
            onChange={(e) => setSecretAccessKey(e.target.value)}
            placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono text-sm pr-10 placeholder-gray-400"
            disabled={isAuthenticating}
          />
          <button
            type="button"
            onClick={() => setShowSecretKey(!showSecretKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            {showSecretKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>
      
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Session Token <span className="text-gray-400">(optional)</span>
        </label>
        <div className="relative">
          <input
            type={showSessionToken ? 'text' : 'password'}
            value={sessionToken}
            onChange={(e) => setSessionToken(e.target.value)}
            placeholder="For temporary credentials only"
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 font-mono text-sm pr-10 placeholder-gray-400"
            disabled={isAuthenticating}
          />
          <button
            type="button"
            onClick={() => setShowSessionToken(!showSessionToken)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          >
            {showSessionToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>
      
      <DefaultRegionPicker
        selectedRegion={selectedDefaultRegion}
        setSelectedRegion={setSelectedDefaultRegion}
        disabled={isAuthenticating}
      />

      <Button
        onClick={onSubmit}
        disabled={isAuthenticating || !accessKeyId || !secretAccessKey}
        className="bg-amber-600 hover:bg-amber-700 text-white"
      >
        {isAuthenticating ? (
          <>
            <Loader2 className="size-4 mr-2 animate-spin" />
            Validating...
          </>
        ) : (
          'Authenticate'
        )}
      </Button>
    </div>
  )
}
