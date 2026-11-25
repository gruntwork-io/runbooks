import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AdcPrincipalCard } from "./AdcPrincipalCard"
import { GcloudConfigurationList } from "./GcloudConfigurationList"
import { RegionPicker } from "./RegionPicker"
import type { AdcInfo, AdcPrincipalLookup, GcloudConfigInfo, GoogleAuthStatus } from "../types"

interface GcloudConfigSelectorProps {
  authStatus: GoogleAuthStatus
  configs: GcloudConfigInfo[]
  selectedConfig: GcloudConfigInfo | null
  setSelectedConfig: (config: GcloudConfigInfo | null) => void
  loadingConfigs: boolean
  configSearch: string
  setConfigSearch: (value: string) => void
  adcInfo: AdcInfo | null
  adcPrincipal: AdcPrincipalLookup
  selectedRegion: string
  setSelectedRegion: (value: string) => void
  onGcloudAuth: () => void
  onRefreshConfigs: () => void
}

export function GcloudConfigSelector(props: GcloudConfigSelectorProps) {
  const isAuthenticating = props.authStatus === "authenticating"
  return (
    <div className="space-y-4">
      <AdcPrincipalCard lookup={props.adcPrincipal} adcInfo={props.adcInfo} />
      <ConfigurationSettings {...props} />
      <RegionPicker
        selectedRegion={props.selectedRegion}
        setSelectedRegion={props.setSelectedRegion}
        disabled={isAuthenticating}
      />
      <UseCredentialsButton {...props} />
      <RefreshLink onClick={props.onRefreshConfigs} disabled={props.loadingConfigs} />
    </div>
  )
}

function ConfigurationSettings(props: GcloudConfigSelectorProps) {
  if (props.adcPrincipal.status !== "signed-in" || props.configs.length === 0) return null
  return (
    <GcloudConfigurationList
      configurations={props.configs}
      signedIn={props.adcPrincipal}
      selected={props.selectedConfig}
      onSelect={props.setSelectedConfig}
      search={props.configSearch}
      onSearch={props.setConfigSearch}
      disabled={props.authStatus === "authenticating"}
    />
  )
}

function UseCredentialsButton({
  authStatus,
  adcPrincipal,
  onGcloudAuth,
}: GcloudConfigSelectorProps) {
  const isAuthenticating = authStatus === "authenticating"
  return (
    <Button
      onClick={onGcloudAuth}
      disabled={isAuthenticating || adcPrincipal.status !== "signed-in"}
      className="bg-info hover:bg-info/90 text-info-foreground"
    >
      {isAuthenticating && <Loader2 className="size-4 mr-2 animate-spin" />}
      {isAuthenticating ? "Authenticating..." : "Use These Credentials"}
    </Button>
  )
}

function RefreshLink({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-sm text-info hover:text-info/90 hover:underline ml-5 cursor-pointer"
      disabled={disabled}
    >
      Refresh
    </button>
  )
}
