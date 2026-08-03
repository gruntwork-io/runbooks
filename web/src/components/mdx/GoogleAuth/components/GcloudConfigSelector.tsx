import { Loader2, Check, Info, ShieldCheck } from "lucide-react"
import { SearchInput } from "./SearchInput"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { RegionPicker } from "./RegionPicker"
import type { AdcInfo, GcloudConfigInfo, GoogleAuthStatus } from "../types"

interface GcloudConfigSelectorProps {
  authStatus: GoogleAuthStatus
  configs: GcloudConfigInfo[]
  selectedConfig: GcloudConfigInfo | null
  setSelectedConfig: (config: GcloudConfigInfo) => void
  loadingConfigs: boolean
  configSearch: string
  setConfigSearch: (value: string) => void
  /** Metadata for the well-known application_default_credentials.json, or null. */
  adcInfo: AdcInfo | null
  /** Resolved gcloud config root, for the "nothing found at X" copy. */
  configRoot: string | null
  selectedRegion: string
  setSelectedRegion: (value: string) => void
  /** hook: `handleGcloudAuth` */
  onGcloudAuth: () => void
  /** hook: `loadGcloudConfigs` */
  onRefreshConfigs: () => void
}

const authTypeLabels: Record<GcloudConfigInfo['authType'], string> = {
  'adc-user': 'User ADC',
  'adc-service-account': 'Service Account ADC',
  'adc-external': 'Federated ADC',
  'config-only': 'No ADC',
  'unsupported': 'Unsupported',
}

const authTypeBadgeStyles: Record<GcloudConfigInfo['authType'], string> = {
  'adc-user': 'bg-success-muted text-success',
  'adc-service-account': 'bg-info-muted text-info',
  'adc-external': 'bg-info-muted text-info',
  'config-only': 'bg-warning-muted text-warning-foreground',
  'unsupported': 'bg-muted text-muted-foreground',
}

/** A gcloud configuration is only usable when Application Default Credentials back it. */
function isUsable(config: GcloudConfigInfo): boolean {
  return config.authType === 'adc-user'
    || config.authType === 'adc-service-account'
    || config.authType === 'adc-external'
}

/**
 * gcloud configuration tab — the ProfileSelector analogue.
 *
 * The one place this tab does more than its AWS counterpart: an AWS profile is
 * self-sufficient, a gcloud configuration is not. Configurations with no
 * Application Default Credentials are listed (so the user sees them) but are not
 * selectable, with the `gcloud auth application-default login` remedy inline.
 */
export function GcloudConfigSelector({
  authStatus,
  configs,
  selectedConfig,
  setSelectedConfig,
  loadingConfigs,
  configSearch,
  setConfigSearch,
  adcInfo,
  configRoot,
  selectedRegion,
  setSelectedRegion,
  onGcloudAuth,
  onRefreshConfigs,
}: GcloudConfigSelectorProps) {
  const isAuthenticating = authStatus === 'authenticating'
  const filteredConfigs = configs.filter((config) =>
    config.name.toLowerCase().includes(configSearch.toLowerCase())
    || (config.project?.toLowerCase().includes(configSearch.toLowerCase()) ?? false)
    || (config.account?.toLowerCase().includes(configSearch.toLowerCase()) ?? false)
  )
  const selectedIsUsable = selectedConfig !== null && isUsable(selectedConfig)

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">
          Select gcloud Configuration
        </label>
        {loadingConfigs ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-2">
            <Loader2 className="size-4 animate-spin" />
            Loading configurations from {configRoot ?? 'the gcloud config directory'}...
          </div>
        ) : configs.length > 0 ? (
          <div className="space-y-2">
            {/* Search input */}
            <SearchInput
              value={configSearch}
              onChange={setConfigSearch}
              placeholder="Search configurations..."
              disabled={isAuthenticating}
            />

            {/* Configuration list */}
            <div className="max-h-[300px] overflow-y-auto space-y-2 p-1">
              {filteredConfigs.map((config) => {
                const usable = isUsable(config)
                const isSelected = usable && selectedConfig?.name === config.name
                return (
                  <button
                    key={config.name}
                    type="button"
                    onClick={() => usable && setSelectedConfig(config)}
                    disabled={isAuthenticating || !usable}
                    className={cn(
                      "w-full text-left px-4 py-3 rounded-md border transition-colors",
                      !usable
                        ? "bg-muted/50 border-border cursor-not-allowed"
                        : isSelected
                          ? "bg-info-muted border-info/40 ring-2 ring-info/40"
                          : "bg-info-muted/50 border-border hover:bg-info-muted hover:border-info/40 cursor-pointer"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Check
                          className={cn(
                            "h-4 w-4 shrink-0",
                            isSelected ? "opacity-100 text-info" : "opacity-0"
                          )}
                        />
                        <div className="min-w-0">
                          <div className="font-medium text-foreground flex items-center gap-2">
                            <span className="truncate">{config.name}</span>
                            {config.isActive && (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-accent text-muted-foreground font-normal shrink-0">
                                active
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-muted-foreground truncate">
                            {config.project ?? 'No project set'}
                            {config.account && ` • ${config.account}`}
                          </div>
                        </div>
                      </div>
                      <span className={cn(
                        "text-xs px-2 py-0.5 rounded-full shrink-0",
                        authTypeBadgeStyles[config.authType]
                      )}>
                        {authTypeLabels[config.authType]}
                      </span>
                    </div>
                    {config.authType === 'config-only' && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        Configuration found, but no Application Default Credentials — run{' '}
                        <code className="bg-accent px-1 rounded">gcloud auth application-default login</code>.
                      </div>
                    )}
                  </button>
                )
              })}
              {filteredConfigs.length === 0 && configSearch && (
                <div className="text-muted-foreground text-sm py-4 text-center">
                  No configurations match "{configSearch}"
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-muted-foreground text-sm py-2">
              No gcloud configurations found{configRoot ? ` at ${configRoot}` : ''}.
            </div>
            <div className="text-xs text-muted-foreground bg-muted rounded-md px-3 py-2 flex items-start gap-2">
              <Info className="size-3.5 mt-0.5 shrink-0" />
              <span>
                Run <code className="bg-accent px-1 rounded">gcloud init</code> to create one, then{' '}
                <code className="bg-accent px-1 rounded">gcloud auth application-default login</code>{' '}
                so applications can use it.
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Application Default Credentials backing these configurations */}
      {adcInfo && (
        <div className="text-xs text-muted-foreground bg-muted rounded-md px-3 py-2 flex items-start gap-2">
          <ShieldCheck className="size-3.5 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div>
              Application Default Credentials
              {adcInfo.clientEmail && <> for <span className="font-mono">{adcInfo.clientEmail}</span></>}
            </div>
            <div className="font-mono truncate" title={adcInfo.path}>{adcInfo.path}</div>
          </div>
        </div>
      )}

      <RegionPicker
        selectedRegion={selectedRegion}
        setSelectedRegion={setSelectedRegion}
        disabled={isAuthenticating}
      />

      <Button
        onClick={onGcloudAuth}
        disabled={isAuthenticating || !selectedIsUsable}
        className="bg-info hover:bg-info/90 text-info-foreground"
      >
        {isAuthenticating ? (
          <>
            <Loader2 className="size-4 mr-2 animate-spin" />
            Authenticating...
          </>
        ) : (
          'Use Selected Configuration'
        )}
      </Button>

      <button
        type="button"
        onClick={onRefreshConfigs}
        className="text-sm text-info hover:text-info/90 hover:underline ml-5 cursor-pointer"
        disabled={loadingConfigs}
      >
        Refresh configurations
      </button>
    </div>
  )
}
