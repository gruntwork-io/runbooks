import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AdcPrincipalCard } from "./AdcPrincipalCard"
import { GcloudConfigurationList } from "./GcloudConfigurationList"
import { GcloudSettingsSummary } from "./GcloudSettingsSummary"
import { RegionPicker } from "./RegionPicker"
import type {
  AdcInfo,
  AdcPrincipalLookup,
  GcloudConfigInfo,
  GoogleAuthStatus,
  SignedInAdcPrincipal,
} from "../types"
import { describeGcloudSettings, isForAnotherAccount } from "../utils"
import { formatGcloudAdcLoginCommand } from "../../../../../../src/domain/google/scopes"

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
  requiredScopes: string[]
  pinnedProject: string | undefined
  defaultRegion: string | undefined
  defaultZone: string | undefined
  selectedRegion: string
  setSelectedRegion: (value: string) => void
  onGcloudAuth: () => void
  onRefreshConfigs: () => void
}

export function GcloudConfigSelector(props: GcloudConfigSelectorProps) {
  const isBusy = props.authStatus === "authenticating"
  return (
    <div className="space-y-4">
      <AdcPrincipalCard
        lookup={props.adcPrincipal}
        adcInfo={props.adcInfo}
        requiredScopes={props.requiredScopes}
        onReload={props.onRefreshConfigs}
        reloadDisabled={props.loadingConfigs || isBusy}
      />
      {props.adcPrincipal.status === "signed-in" && (
        <SignInControls {...props} signedIn={props.adcPrincipal} isBusy={isBusy} />
      )}
    </div>
  )
}

type SignInControlsProps = GcloudConfigSelectorProps & {
  signedIn: SignedInAdcPrincipal
  isBusy: boolean
}

function SignInControls(props: SignInControlsProps) {
  const [isChanging, setIsChanging] = useState(false)
  return (
    <>
      {isChanging ? (
        <SettingsEditor {...props} onDone={() => setIsChanging(false)} />
      ) : (
        <SettingsOverview {...props} onChange={() => setIsChanging(true)} />
      )}
      <ContinueButton {...props} />
      <WrongAccountHelp />
    </>
  )
}

function SettingsOverview(props: SignInControlsProps & { onChange: () => void }) {
  const settings = describeGcloudSettings({
    configuration: props.selectedConfig,
    pinnedProject: props.pinnedProject,
    quotaProject: props.adcInfo?.quotaProjectId,
    pickedRegion: props.selectedRegion,
    defaultRegion: props.defaultRegion,
    defaultZone: props.defaultZone,
  })
  return (
    <div className="space-y-2">
      <GcloudSettingsSummary
        settings={settings}
        onChange={props.onChange}
        disabled={props.isBusy}
      />
      <UnusedConfigurationNote {...props} />
    </div>
  )
}

function UnusedConfigurationNote({ configs, selectedConfig, signedIn }: SignInControlsProps) {
  const unused = configs.find((configuration) => isForAnotherAccount(configuration, signedIn))
  if (selectedConfig || !unused) return null
  return (
    <p className="text-xs text-muted-foreground">
      Your gcloud configuration <strong>{unused.name}</strong> is set up for {unused.account}, so
      its project and region are not used.
    </p>
  )
}

function SettingsEditor(props: SignInControlsProps & { onDone: () => void }) {
  return (
    <div className="border border-border rounded-md p-4 space-y-4">
      {props.configs.length > 0 && <ConfigurationChoice {...props} />}
      <RegionChoice {...props} />
      <Button type="button" variant="outline" size="sm" onClick={props.onDone}>
        Done
      </Button>
    </div>
  )
}

function ConfigurationChoice(props: SignInControlsProps) {
  return (
    <GcloudConfigurationList
      configurations={props.configs}
      signedIn={props.signedIn}
      selected={props.selectedConfig}
      onSelect={props.setSelectedConfig}
      search={props.configSearch}
      onSearch={props.setConfigSearch}
      disabled={props.isBusy}
    />
  )
}

function RegionChoice(props: SignInControlsProps) {
  const configurationRegion = props.selectedConfig?.region
  return (
    <div className="space-y-1">
      <RegionPicker
        selectedRegion={props.selectedRegion}
        setSelectedRegion={props.setSelectedRegion}
        disabled={props.isBusy}
      />
      {configurationRegion && (
        <p className="text-xs text-muted-foreground">
          Leave the region unset to use {configurationRegion}, from the configuration.
        </p>
      )}
    </div>
  )
}

function ContinueButton({ signedIn, isBusy, onGcloudAuth }: SignInControlsProps) {
  const account = signedIn.principal ? ` as ${signedIn.principal}` : ""
  return (
    <Button
      onClick={onGcloudAuth}
      disabled={isBusy}
      className="bg-info hover:bg-info/90 text-info-foreground"
    >
      {isBusy && <Loader2 className="size-4 mr-2 animate-spin" />}
      {isBusy ? `Signing in${account}...` : `Continue${account}`}
    </Button>
  )
}

function WrongAccountHelp() {
  return (
    <details className="text-sm">
      <summary className="text-info cursor-pointer">Not the right account?</summary>
      <p className="mt-2 text-muted-foreground">
        In a terminal, run{" "}
        <code className="bg-accent px-1 rounded">{formatGcloudAdcLoginCommand([])}</code> and choose
        the account you want in the browser. Then click <strong>Reload</strong>.
      </p>
    </details>
  )
}
