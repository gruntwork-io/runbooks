import { useState } from "react"
import { X, Info, AlertTriangle, AlertCircle, CheckCircle } from "lucide-react"
import { cn } from "@/lib/utils"

type AdmonitionType = "note" | "info" | "warning" | "danger"

interface AdmonitionProps {
  type: AdmonitionType
  title?: string
  children: React.ReactNode
  closable?: boolean
  className?: string
}

const admonitionConfig: Record<
  AdmonitionType,
  {
    icon: React.ComponentType<{ className?: string }>
    bgColor: string
    borderColor: string
    textColor: string
    iconColor: string
    defaultTitle: string
  }
> = {
  note: {
    icon: CheckCircle,
    bgColor: "bg-gray-50",
    borderColor: "border-gray-300",
    textColor: "text-gray-700",
    iconColor: "text-gray-500",
    defaultTitle: "Note",
  },
  info: {
    icon: Info,
    bgColor: "bg-blue-50",
    borderColor: "border-blue-200",
    textColor: "text-blue-700",
    iconColor: "text-blue-500",
    defaultTitle: "Info",
  },
  warning: {
    icon: AlertTriangle,
    bgColor: "bg-yellow-50",
    borderColor: "border-yellow-300",
    textColor: "text-yellow-700",
    iconColor: "text-yellow-500",
    defaultTitle: "Warning",
  },
  danger: {
    icon: AlertCircle,
    bgColor: "bg-red-50",
    borderColor: "border-red-200",
    textColor: "text-red-700",
    iconColor: "text-red-500",
    defaultTitle: "Danger",
  },
}

export function Admonition({
  type,
  title,
  children,
  closable = false,
  className,
}: AdmonitionProps) {
  const [isVisible, setIsVisible] = useState(true)

  if (!isVisible) return null

  const config = admonitionConfig[type]
  const Icon = config.icon
  const displayTitle = title || config.defaultTitle

  return (
    <div
      className={cn(
        "rounded-md border p-3 text-sm flex items-start gap-2",
        config.bgColor,
        config.borderColor,
        config.textColor,
        className
      )}
    >
      <Icon className={cn("size-4 mt-0.5 flex-shrink-0", config.iconColor)} />
      <div className="flex-1">
        <strong>{displayTitle}:</strong> {children}
      </div>
      {closable && (
        <button
          onClick={() => setIsVisible(false)}
          className={cn(
            "flex-shrink-0 hover:opacity-70 transition-opacity cursor-pointer",
            config.iconColor
          )}
          aria-label="Close"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}

export default Admonition

