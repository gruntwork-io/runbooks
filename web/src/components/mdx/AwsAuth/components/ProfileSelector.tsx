import { Loader2, Check, Info, Asterisk } from "lucide-react"
import { SearchInput } from "./SearchInput"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { DefaultRegionPicker } from "./DefaultRegionPicker"
import type { AuthStatus, ProfileInfo } from "../types"

interface ProfileSelectorProps {
  authStatus: AuthStatus
  profiles: ProfileInfo[]
  selectedProfile: ProfileInfo | null
  setSelectedProfile: (profile: ProfileInfo) => void
  loadingProfiles: boolean
  profileSearch: string
  setProfileSearch: (value: string) => void
  selectedDefaultRegion: string
  setSelectedDefaultRegion: (value: string) => void
  onProfileAuth: () => void
  onRefreshProfiles: () => void
}

export function ProfileSelector({
  authStatus,
  profiles,
  selectedProfile,
  setSelectedProfile,
  loadingProfiles,
  profileSearch,
  setProfileSearch,
  selectedDefaultRegion,
  setSelectedDefaultRegion,
  onProfileAuth,
  onRefreshProfiles,
}: ProfileSelectorProps) {
  const isAuthenticating = authStatus === 'authenticating'
  const usableProfiles = profiles.filter(p => p.authType === 'static' || p.authType === 'assume_role')
  const filteredProfiles = usableProfiles.filter(profile =>
    profile.name.toLowerCase().includes(profileSearch.toLowerCase())
  )
  const hasSsoProfiles = profiles.some(p => p.authType === 'sso')

  const authTypeLabels: Record<string, string> = {
    'static': 'Static Credentials',
    'assume_role': 'Assume Role',
  }
  const authTypeBadgeStyles: Record<string, string> = {
    'static': 'bg-success-muted text-success',
    'assume_role': 'bg-info-muted text-info',
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">
          Select AWS Profile
        </label>
        {loadingProfiles ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-2">
            <Loader2 className="size-4 animate-spin" />
            Loading profiles from ~/.aws/credentials...
          </div>
        ) : usableProfiles.length > 0 ? (
          <div className="space-y-2">
            {/* Search input */}
            <SearchInput
              value={profileSearch}
              onChange={setProfileSearch}
              placeholder="Search profiles..."
              disabled={isAuthenticating}
            />

            {/* Profile list */}
            <div className="max-h-[300px] overflow-y-auto space-y-2 p-1">
              {filteredProfiles.map((profile) => {
                const isSelected = selectedProfile?.name === profile.name
                return (
                  <button
                    key={profile.name}
                    onClick={() => setSelectedProfile(profile)}
                    disabled={isAuthenticating}
                    className={cn(
                      "w-full text-left px-4 py-3 rounded-md border transition-colors",
                      isSelected
                        ? "bg-info-muted border-info/40 ring-2 ring-info/40"
                        : "bg-info-muted/50 border-border hover:bg-info-muted hover:border-info/40 cursor-pointer"
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Check
                          className={cn(
                            "h-4 w-4 shrink-0",
                            isSelected ? "opacity-100 text-info" : "opacity-0"
                          )}
                        />
                        <span className="font-medium text-foreground">
                          {profile.name}
                        </span>
                      </div>
                      <span className={cn(
                        "text-xs px-2 py-0.5 rounded-full",
                        authTypeBadgeStyles[profile.authType]
                      )}>
                        {authTypeLabels[profile.authType]}
                      </span>
                    </div>
                  </button>
                )
              })}
              {filteredProfiles.length === 0 && profileSearch && (
                <div className="text-muted-foreground text-sm py-4 text-center">
                  No profiles match "{profileSearch}"
                </div>
              )}
            </div>
            
            {/* SSO profiles notice */}
            {hasSsoProfiles && (
              <div className="text-xs text-muted-foreground bg-muted rounded-md px-3 py-2 flex items-start gap-1">
                <Asterisk className="size-3.5 mt-0.5 shrink-0" />
                <span>SSO profiles are not shown here. Use the <strong>AWS SSO</strong> tab instead.</span>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-muted-foreground text-sm py-2">
              No static credential or assume role profiles found.
            </div>
            {hasSsoProfiles && (
              <div className="text-xs text-muted-foreground bg-muted rounded-md px-3 py-2 flex items-start gap-2">
                <Info className="size-3.5 mt-0.5 shrink-0" />
                <span>SSO profiles are not shown here. Use the <strong>AWS SSO</strong> tab instead.</span>
              </div>
            )}
          </div>
        )}
      </div>

      <DefaultRegionPicker
        selectedRegion={selectedDefaultRegion}
        setSelectedRegion={setSelectedDefaultRegion}
        disabled={isAuthenticating}
      />
      
      <Button
        onClick={onProfileAuth}
        disabled={isAuthenticating || !selectedProfile || selectedProfile.authType === 'unsupported'}
        className="bg-warning hover:bg-warning/90 text-white"
      >
        {isAuthenticating ? (
          <>
            <Loader2 className="size-4 mr-2 animate-spin" />
            Authenticating...
          </>
        ) : (
          'Use Selected Profile'
        )}
      </Button>
      
      <button
        onClick={onRefreshProfiles}
        className="text-sm text-warning hover:text-warning/90 hover:underline ml-5 cursor-pointer"
        disabled={loadingProfiles}
      >
        Refresh profiles
      </button>
    </div>
  )
}
