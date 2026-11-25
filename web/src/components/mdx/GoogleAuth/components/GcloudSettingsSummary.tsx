import type { GcloudSetting } from "../utils"

interface GcloudSettingsSummaryProps {
  settings: GcloudSetting[]
  onChange: () => void
  disabled: boolean
}

export function GcloudSettingsSummary({
  settings,
  onChange,
  disabled,
}: GcloudSettingsSummaryProps) {
  return (
    <div className="flex items-center gap-3">
      <dl className="grid grid-cols-[4rem_minmax(0,1fr)] gap-x-3 gap-y-1 flex-1 text-sm">
        {settings.map((setting) => (
          <SettingLine key={setting.label} setting={setting} />
        ))}
      </dl>
      <ChangeLink onClick={onChange} disabled={disabled} />
    </div>
  )
}

function ChangeLink({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-sm text-info hover:text-info/90 hover:underline cursor-pointer"
    >
      Change
    </button>
  )
}

function SettingLine({ setting }: { setting: GcloudSetting }) {
  return (
    <>
      <dt className="text-muted-foreground">{setting.label}</dt>
      <dd className="min-w-0 truncate">
        <span className="font-medium text-foreground">{setting.value}</span>
        {setting.source && <span className="text-muted-foreground"> {setting.source}</span>}
      </dd>
    </>
  )
}
