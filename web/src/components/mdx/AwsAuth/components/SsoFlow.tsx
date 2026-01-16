import { Loader2, ExternalLink, AlertTriangle, XCircle, Check, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { DefaultRegionPicker } from "./DefaultRegionPicker"
import type { AuthStatus, SSOAccount, SSORole } from "../types"

interface SsoFormProps {
  authStatus: AuthStatus
  ssoStartUrl?: string
  selectedDefaultRegion: string
  setSelectedDefaultRegion: (value: string) => void
  onSsoAuth: () => void
  onCancelSsoAuth: () => void
}

export function SsoForm({
  authStatus,
  ssoStartUrl,
  selectedDefaultRegion,
  setSelectedDefaultRegion,
  onSsoAuth,
  onCancelSsoAuth,
}: SsoFormProps) {
  const isAuthenticating = authStatus === 'authenticating'

  if (!ssoStartUrl) {
    return (
      <div className="text-amber-700 text-sm flex items-start gap-2">
        <AlertTriangle className="size-4 mt-0.5 flex-shrink-0" />
        <div>
          SSO Start URL is not configured. Add <code className="bg-amber-100 px-1 rounded">ssoStartUrl</code> prop to enable SSO authentication.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="bg-amber-100/50 rounded p-3 text-sm text-gray-700">
        {isAuthenticating ? (
          <p>
            Complete the authorization request in the applicable browser tab.<br/>
            <span className="text-gray-500 text-xs mt-1 block">
              Note: If you cancelled on AWS, click the Cancel button below — AWS doesn't notify this page when you cancel.
            </span>
          </p>                        
        ) : (
          <>
            <p className="mb-2">
              Click the button below to open AWS IAM Identity Center (formerly AWS SSO) in your browser. After authenticating, you'll be redirected back here.
            </p>
            <div className="font-mono text-xs text-gray-500 truncate">
              {ssoStartUrl}
            </div>
          </>
        )}
      </div>

      <DefaultRegionPicker
        selectedRegion={selectedDefaultRegion}
        setSelectedRegion={setSelectedDefaultRegion}
        disabled={isAuthenticating}
      />
      
      <div className="flex gap-2">
        <Button
          onClick={onSsoAuth}
          disabled={isAuthenticating}
          className="bg-amber-600 hover:bg-amber-700 text-white"
        >
          {isAuthenticating ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Waiting for browser authentication...
            </>
          ) : (
            <>
              <ExternalLink className="size-4" />
              Sign in with SSO
            </>
          )}
        </Button>
        
        {isAuthenticating && (
          <Button
            onClick={onCancelSsoAuth}
            variant="outline"
            className="border-gray-300 text-gray-700 hover:bg-gray-100"
          >
            <XCircle className="size-4" />
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}

interface SsoAccountSelectorProps {
  accounts: SSOAccount[]
  selectedAccount: SSOAccount | null
  loadingRoles: boolean
  searchValue: string
  setSearchValue: (value: string) => void
  onAccountSelect: (account: SSOAccount) => void
  onCancel: () => void
}

export function SsoAccountSelector({
  accounts,
  selectedAccount,
  loadingRoles,
  searchValue,
  setSearchValue,
  onAccountSelect,
  onCancel,
}: SsoAccountSelectorProps) {
  const filteredAccounts = accounts.filter((account) =>
    account.accountName.toLowerCase().includes(searchValue.toLowerCase()) ||
    account.accountId.includes(searchValue) ||
    (account.emailAddress && account.emailAddress.toLowerCase().includes(searchValue.toLowerCase()))
  )

  return (
    <div className="space-y-4">
      <div className="text-blue-700 font-semibold text-sm mb-2">
        ✓ SSO authentication successful
      </div>
      <div className="bg-blue-100/50 rounded p-3 text-sm text-gray-700">
        <p>Select an AWS account to continue:</p>
      </div>
      
      <div className="space-y-2">
        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-gray-400" />
          <input
            type="text"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            placeholder="Search accounts..."
            className="w-full pl-9 pr-8 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
            disabled={loadingRoles}
          />
          {searchValue && (
            <button
              onClick={() => setSearchValue('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        
        {/* Account list */}
        <div className="max-h-[300px] overflow-y-auto space-y-2 p-1">
          {filteredAccounts.map((account) => {
            const isSelected = selectedAccount?.accountId === account.accountId
            return (
              <button
                key={account.accountId}
                onClick={() => onAccountSelect(account)}
                disabled={loadingRoles}
                className={cn(
                  "w-full text-left px-4 py-3 rounded-md border transition-colors",
                  isSelected
                    ? "bg-blue-100 border-blue-400 ring-2 ring-blue-200"
                    : "bg-blue-50 border-gray-200 hover:bg-blue-100 hover:border-blue-300 cursor-pointer"
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Check
                      className={cn(
                        "h-4 w-4 shrink-0",
                        isSelected ? "opacity-100 text-blue-600" : "opacity-0"
                      )}
                    />
                    <div>
                      <div className="font-medium text-gray-900">{account.accountName}</div>
                      <div className="text-sm text-gray-500">
                        {account.accountId}
                        {account.emailAddress && ` • ${account.emailAddress}`}
                      </div>
                    </div>
                  </div>
                  {loadingRoles && isSelected && (
                    <Loader2 className="size-4 animate-spin text-blue-600" />
                  )}
                </div>
              </button>
            )
          })}
          {filteredAccounts.length === 0 && searchValue && (
            <div className="text-gray-500 text-sm py-4 text-center">
              No accounts match "{searchValue}"
            </div>
          )}
        </div>
      </div>
      
      <Button
        onClick={onCancel}
        variant="outline"
        className="border-gray-300 text-gray-700 hover:bg-gray-100"
      >
        Cancel
      </Button>
    </div>
  )
}

interface SsoRoleSelectorProps {
  selectedAccount: SSOAccount
  roles: SSORole[]
  selectedRole: string
  setSelectedRole: (role: string) => void
  searchValue: string
  setSearchValue: (value: string) => void
  onComplete: () => void
  onBack: () => void
}

export function SsoRoleSelector({
  selectedAccount,
  roles,
  selectedRole,
  setSelectedRole,
  searchValue,
  setSearchValue,
  onComplete,
  onBack,
}: SsoRoleSelectorProps) {
  const filteredRoles = roles.filter((role) =>
    role.roleName.toLowerCase().includes(searchValue.toLowerCase())
  )

  return (
    <div className="space-y-4">
      <div className="text-blue-700 font-semibold text-sm mb-2">
        ✓ Account selected: {selectedAccount.accountName}
      </div>
      <div className="bg-blue-100/50 rounded p-3 text-sm text-gray-700">
        <p>Select a role to assume:</p>
      </div>
      
      <div className="space-y-2">
        {/* Search input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-gray-400" />
          <input
            type="text"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            placeholder="Search roles..."
            className="w-full pl-9 pr-8 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          />
          {searchValue && (
            <button
              onClick={() => setSearchValue('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        
        {/* Role list */}
        <div className="max-h-[300px] overflow-y-auto space-y-2 p-1">
          {filteredRoles.map((role) => {
            const isSelected = selectedRole === role.roleName
            return (
              <button
                key={role.roleName}
                onClick={() => setSelectedRole(role.roleName)}
                className={cn(
                  "w-full text-left px-4 py-3 rounded-md border transition-colors",
                  isSelected
                    ? "bg-blue-100 border-blue-400 ring-2 ring-blue-200"
                    : "bg-blue-50 border-gray-200 hover:bg-blue-100 hover:border-blue-300 cursor-pointer"
                )}
              >
                <div className="flex items-center gap-2">
                  <Check
                    className={cn(
                      "h-4 w-4 shrink-0",
                      isSelected ? "opacity-100 text-blue-600" : "opacity-0"
                    )}
                  />
                  <span className="font-medium text-gray-900">{role.roleName}</span>
                </div>
              </button>
            )
          })}
          {filteredRoles.length === 0 && searchValue && (
            <div className="text-gray-500 text-sm py-4 text-center">
              No roles match "{searchValue}"
            </div>
          )}
        </div>
      </div>
      
      <div className="flex gap-2">
        <Button
          onClick={onComplete}
          disabled={!selectedRole}
          className="bg-blue-600 hover:bg-blue-700 text-white"
        >
          Continue
        </Button>
        <Button
          onClick={onBack}
          variant="outline"
          className="border-gray-300 text-gray-700 hover:bg-gray-100"
        >
          Back
        </Button>
      </div>
    </div>
  )
}
