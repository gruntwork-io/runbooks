import { Terminal, Smartphone, KeyRound } from "lucide-react"
import type { AzureAuthMethod } from "../types"

const TABS: ReadonlyArray<{ method: AzureAuthMethod; label: string; Icon: typeof Terminal }> = [
  { method: "cli", label: "Azure CLI", Icon: Terminal },
  { method: "device_code", label: "Device Code", Icon: Smartphone },
  { method: "service_principal", label: "Service Principal", Icon: KeyRound },
]

interface AuthTabsProps {
  authMethod: AzureAuthMethod
  setAuthMethod: (method: AzureAuthMethod) => void
  disabled?: boolean
}

export function AuthTabs({ authMethod, setAuthMethod, disabled = false }: AuthTabsProps) {
  return (
    <div className="flex gap-1 mb-4 border-b border-warning/30" role="tablist">
      {TABS.map(({ method, label, Icon }) => (
        <button
          key={method}
          role="tab"
          aria-selected={authMethod === method}
          disabled={disabled}
          onClick={() => setAuthMethod(method)}
          className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer disabled:cursor-not-allowed ${
            authMethod === method
              ? "text-warning border-b-2 border-warning -mb-px"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Icon className="size-4 inline mr-2" />
          {label}
        </button>
      ))}
    </div>
  )
}
