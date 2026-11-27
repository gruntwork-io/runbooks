import type { ReactNode } from "react"
import { Check } from "lucide-react"
import { SearchInput } from "@/components/mdx/_shared/components/SearchInput"
import { cn } from "@/lib/utils"
import type { GcloudConfigInfo, SignedInAdcPrincipal } from "../types"
import { isForAnotherAccount, isUsableWith } from "../utils"

interface GcloudConfigurationListProps {
  configurations: GcloudConfigInfo[]
  signedIn: SignedInAdcPrincipal
  selected: GcloudConfigInfo | null
  onSelect: (configuration: GcloudConfigInfo | null) => void
  search: string
  onSearch: (value: string) => void
  disabled: boolean
}

const MOST_CONFIGURATIONS_WITHOUT_SEARCH = 6

export function GcloudConfigurationList(props: GcloudConfigurationListProps) {
  const matching = props.configurations.filter((configuration) =>
    matchesSearch(configuration, props.search),
  )
  const isLongList = props.configurations.length > MOST_CONFIGURATIONS_WITHOUT_SEARCH
  const isFiltered = props.search !== ""
  return (
    <div>
      <div className="block text-sm font-medium text-foreground mb-2">
        Take the project, region and zone from
      </div>
      {(isLongList || isFiltered) && <ConfigurationSearch {...props} />}
      <ConfigurationRows {...props} matching={matching} />
    </div>
  )
}

function ConfigurationSearch(props: GcloudConfigurationListProps) {
  return (
    <SearchInput
      value={props.search}
      onChange={props.onSearch}
      placeholder="Search configurations..."
      disabled={props.disabled}
    />
  )
}

function matchesSearch(configuration: GcloudConfigInfo, search: string): boolean {
  const term = search.toLowerCase()
  return [configuration.name, configuration.project, configuration.account].some(
    (field) => field?.toLowerCase().includes(term) ?? false,
  )
}

function ConfigurationRows(props: GcloudConfigurationListProps & { matching: GcloudConfigInfo[] }) {
  return (
    <div className="max-h-[300px] overflow-y-auto space-y-2 p-1">
      <NoConfigurationRow {...props} />
      {props.matching.map((configuration) => (
        <ConfigurationRow key={configuration.name} {...props} configuration={configuration} />
      ))}
      {props.matching.length === 0 && props.search && <NoMatches search={props.search} />}
    </div>
  )
}

function NoMatches({ search }: { search: string }) {
  return (
    <div className="text-muted-foreground text-sm py-4 text-center">
      No configurations match "{search}"
    </div>
  )
}

function NoConfigurationRow({ selected, onSelect, disabled }: GcloudConfigurationListProps) {
  return (
    <RowButton isSelected={selected === null} disabled={disabled} onClick={() => onSelect(null)}>
      <div className="font-medium text-foreground">No configuration</div>
      <div className="text-sm text-muted-foreground">Use your gcloud login on its own.</div>
    </RowButton>
  )
}

function ConfigurationRow(
  props: GcloudConfigurationListProps & { configuration: GcloudConfigInfo },
) {
  const { configuration, signedIn } = props
  return (
    <RowButton
      isSelected={props.selected?.name === configuration.name}
      disabled={props.disabled || !isUsableWith(configuration, signedIn)}
      onClick={() => props.onSelect(configuration)}
    >
      <ConfigurationSummary configuration={configuration} />
      {isForAnotherAccount(configuration, signedIn) && (
        <AnotherAccountNote account={configuration.account} />
      )}
    </RowButton>
  )
}

interface RowButtonProps {
  isSelected: boolean
  disabled: boolean
  onClick: () => void
  children: ReactNode
}

function RowButton({ isSelected, disabled, onClick, children }: RowButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={isSelected}
      className={cn("w-full text-left px-3 py-2 rounded-md border", rowStyle(isSelected, disabled))}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Check className={cn("h-4 w-4 shrink-0 text-info", !isSelected && "opacity-0")} />
        <div className="min-w-0">{children}</div>
      </div>
    </button>
  )
}

function rowStyle(isSelected: boolean, disabled: boolean): string {
  if (isSelected) return "bg-info-muted border-info/40 ring-2 ring-info/40"
  if (disabled) return "bg-muted/50 border-border cursor-not-allowed"
  return "bg-info-muted/50 border-border hover:bg-info-muted hover:border-info/40 cursor-pointer transition-colors"
}

function ConfigurationSummary({ configuration }: { configuration: GcloudConfigInfo }) {
  const settings = [configuration.project ?? "No project set", configuration.region]
  return (
    <>
      <div className="font-medium text-foreground flex items-center gap-2">
        <span className="truncate">{configuration.name}</span>
        {configuration.isActive && <ActiveBadge />}
      </div>
      <div className="text-sm text-muted-foreground truncate">
        {settings.filter(Boolean).join(" • ")}
      </div>
    </>
  )
}

function ActiveBadge() {
  return (
    <span className="text-xs px-2 py-0.5 rounded-full bg-accent text-muted-foreground font-normal shrink-0">
      active
    </span>
  )
}

function AnotherAccountNote({ account }: { account: string | undefined }) {
  return (
    <div className="mt-1 text-xs text-muted-foreground">
      Set up for <span className="font-mono">{account}</span>, so it is not available.
    </div>
  )
}
