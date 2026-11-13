import { useId } from "react"
import { Loader2, ExternalLink, XCircle, Check } from "lucide-react"
import { SearchInput } from "@/components/mdx/_shared/components/SearchInput"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { DefaultRegionPicker } from "./DefaultRegionPicker"
import type { AuthStatus, SSOAccount, SSORole } from "../types"
import type { SsoPortal } from "../utils"

interface SsoFormProps {
  authStatus: AuthStatus
  /** The start URL the sign-in uses: the runbook's, or the one typed below. */
  ssoStartUrl: string
  /**
   * The portal the user fills in when the runbook sets no `ssoStartUrl`, and
   * the portals the local AWS config names. Absent when the runbook sets one.
   */
  portalInput?:
    | {
        portal: SsoPortal
        setPortal: (portal: SsoPortal) => void
        configured: SsoPortal[]
      }
    | undefined
  selectedDefaultRegion: string
  setSelectedDefaultRegion: (value: string) => void
  onSsoAuth: () => void
  onCancelSsoAuth: () => void
}

export function SsoForm({
  authStatus,
  ssoStartUrl,
  portalInput,
  selectedDefaultRegion,
  setSelectedDefaultRegion,
  onSsoAuth,
  onCancelSsoAuth,
}: SsoFormProps) {
  const isAuthenticating = authStatus === "authenticating"
  // Only a URL the user typed is checked: the runbook's own goes as written.
  const startUrlValid = portalInput ? /^https:\/\/\S+$/.test(ssoStartUrl) : ssoStartUrl !== ""

  return (
    <div className="space-y-4">
      {portalInput && (
        <PortalFields
          {...portalInput}
          disabled={isAuthenticating}
          invalid={ssoStartUrl !== "" && !startUrlValid}
        />
      )}

      <div className="bg-warning-muted/50 rounded p-3 text-sm text-foreground">
        {isAuthenticating ? (
          <p>
            Complete the authorization request in the applicable browser tab.
            <br />
            <span className="text-muted-foreground text-xs mt-1 block">
              Note: If you cancelled on AWS, click the Cancel button below — AWS doesn't notify this
              page when you cancel.
            </span>
          </p>
        ) : (
          <>
            <p className={portalInput ? "m-0" : "mb-2"}>
              Click the button below to open AWS IAM Identity Center (formerly AWS SSO) in your
              browser. After authenticating, you'll be redirected back here.
            </p>
            {!portalInput && (
              <div className="font-mono text-xs text-muted-foreground truncate">{ssoStartUrl}</div>
            )}
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
          disabled={isAuthenticating || !startUrlValid}
          className="bg-warning hover:bg-warning/90 text-white"
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
            className="border-input text-foreground hover:bg-accent"
          >
            <XCircle className="size-4" />
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}

/** The start URL and region of the access portal, typed or picked from the AWS config. */
function PortalFields({
  portal,
  setPortal,
  configured,
  disabled,
  invalid,
}: {
  portal: SsoPortal
  setPortal: (portal: SsoPortal) => void
  configured: SsoPortal[]
  disabled: boolean
  invalid: boolean
}) {
  // Each block's field gets its own id, so its label names it on a page of several.
  const startUrlId = useId()
  const others = configured.filter(
    (c) => c.startUrl !== portal.startUrl.trim() || c.region !== portal.region,
  )
  return (
    <>
      <div>
        <label htmlFor={startUrlId} className="block text-sm font-medium text-foreground mb-1">
          SSO start URL <span className="text-destructive">*</span>
        </label>
        <input
          id={startUrlId}
          type="url"
          value={portal.startUrl}
          onChange={(e) => setPortal({ ...portal, startUrl: e.target.value })}
          placeholder="https://my-org.awsapps.com/start"
          aria-invalid={invalid}
          className="w-full px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-2 focus:ring-ring font-mono text-sm placeholder-muted-foreground"
          disabled={disabled}
        />
        {invalid && (
          <p className="text-xs text-destructive mt-1">
            The start URL begins with https://, such as https://my-org.awsapps.com/start.
          </p>
        )}
        {others.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>From your AWS config:</span>
            {others.map((c) => (
              <button
                key={`${c.startUrl} ${c.region}`}
                type="button"
                onClick={() => setPortal(c)}
                disabled={disabled}
                className="font-mono rounded border border-input px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
              >
                {c.startUrl} ({c.region})
              </button>
            ))}
          </div>
        )}
      </div>

      <DefaultRegionPicker
        label="SSO Region"
        hint="The region your organization's IAM Identity Center is in. The AWS access portal's settings page shows it."
        selectedRegion={portal.region}
        setSelectedRegion={(region) => setPortal({ ...portal, region })}
        disabled={disabled}
      />
    </>
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
  const filteredAccounts = accounts.filter(
    (account) =>
      account.accountName.toLowerCase().includes(searchValue.toLowerCase()) ||
      account.accountId.includes(searchValue) ||
      (account.emailAddress &&
        account.emailAddress.toLowerCase().includes(searchValue.toLowerCase())),
  )

  return (
    <div className="space-y-4">
      <div className="text-info font-semibold text-sm mb-2">✓ SSO authentication successful</div>
      <div className="bg-info-muted/50 rounded p-3 text-sm text-foreground">
        <p>Select an AWS account to continue:</p>
      </div>

      <div className="space-y-2">
        {/* Search input */}
        <SearchInput
          value={searchValue}
          onChange={setSearchValue}
          placeholder="Search accounts..."
          disabled={loadingRoles}
        />

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
                    ? "bg-info-muted border-info/40 ring-2 ring-info/40"
                    : "bg-info-muted/50 border-border hover:bg-info-muted hover:border-info/40 cursor-pointer",
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Check
                      className={cn(
                        "h-4 w-4 shrink-0",
                        isSelected ? "opacity-100 text-info" : "opacity-0",
                      )}
                    />
                    <div>
                      <div className="font-medium text-foreground">{account.accountName}</div>
                      <div className="text-sm text-muted-foreground">
                        {account.accountId}
                        {account.emailAddress && ` • ${account.emailAddress}`}
                      </div>
                    </div>
                  </div>
                  {loadingRoles && isSelected && (
                    <Loader2 className="size-4 animate-spin text-info" />
                  )}
                </div>
              </button>
            )
          })}
          {filteredAccounts.length === 0 && searchValue && (
            <div className="text-muted-foreground text-sm py-4 text-center">
              No accounts match "{searchValue}"
            </div>
          )}
        </div>
      </div>

      <Button
        onClick={onCancel}
        variant="outline"
        className="border-input text-foreground hover:bg-accent"
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
    role.roleName.toLowerCase().includes(searchValue.toLowerCase()),
  )

  return (
    <div className="space-y-4">
      <div className="text-info font-semibold text-sm mb-2">
        ✓ Account selected: {selectedAccount.accountName}
      </div>
      <div className="bg-info-muted/50 rounded p-3 text-sm text-foreground">
        <p>Select a role to assume:</p>
      </div>

      <div className="space-y-2">
        {/* Search input */}
        <SearchInput value={searchValue} onChange={setSearchValue} placeholder="Search roles..." />

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
                    ? "bg-info-muted border-info/40 ring-2 ring-info/40"
                    : "bg-info-muted/50 border-border hover:bg-info-muted hover:border-info/40 cursor-pointer",
                )}
              >
                <div className="flex items-center gap-2">
                  <Check
                    className={cn(
                      "h-4 w-4 shrink-0",
                      isSelected ? "opacity-100 text-info" : "opacity-0",
                    )}
                  />
                  <span className="font-medium text-foreground">{role.roleName}</span>
                </div>
              </button>
            )
          })}
          {filteredRoles.length === 0 && searchValue && (
            <div className="text-muted-foreground text-sm py-4 text-center">
              No roles match "{searchValue}"
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          onClick={onComplete}
          disabled={!selectedRole}
          className="bg-info hover:bg-info/90 text-white"
        >
          Continue
        </Button>
        <Button
          onClick={onBack}
          variant="outline"
          className="border-input text-foreground hover:bg-accent"
        >
          Back
        </Button>
      </div>
    </div>
  )
}
