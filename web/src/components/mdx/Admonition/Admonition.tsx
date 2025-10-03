import { useState } from "react"
import { X, Info, AlertTriangle, AlertCircle, CheckCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { InlineMarkdown } from "@/components/mdx/shared/components/InlineMarkdown"

type AdmonitionType = "note" | "info" | "warning" | "danger"

interface AdmonitionProps {
  type: AdmonitionType
  title?: string
  description?: string
  closable?: boolean
  confirmationText?: string
  children?: React.ReactNode
  className?: string
}

const admonitionConfig: Record<
  AdmonitionType,
  {
    icon: React.ComponentType<{ className?: string }>
    bgColor: string
    borderColor: string
    separatorColor: string
    textColor: string
    iconColor: string
    defaultTitle: string
  }
> = {
  note: {
    icon: CheckCircle,
    bgColor: "bg-gray-50",
    borderColor: "border-gray-300",
    separatorColor: "border-gray-200",
    textColor: "text-gray-700",
    iconColor: "text-gray-500",
    defaultTitle: "Note",
  },
  info: {
    icon: Info,
    bgColor: "bg-blue-50",
    borderColor: "border-blue-200",
    separatorColor: "border-blue-200",
    textColor: "text-blue-700",
    iconColor: "text-blue-500",
    defaultTitle: "Info",
  },
  warning: {
    icon: AlertTriangle,
    bgColor: "bg-yellow-50",
    borderColor: "border-yellow-300",
    separatorColor: "border-yellow-200",
    textColor: "text-yellow-700",
    iconColor: "text-yellow-500",
    defaultTitle: "Warning",
  },
  danger: {
    icon: AlertCircle,
    bgColor: "bg-red-50",
    borderColor: "border-red-200",
    separatorColor: "border-red-200",
    textColor: "text-red-700",
    iconColor: "text-red-500",
    defaultTitle: "Danger",
  },
}

export function Admonition({
  type,
  title,
  description,
  children,
  closable = false,
  confirmationText,
  className,
}: AdmonitionProps) {
  const [isVisible, setIsVisible] = useState(true)
  const [isConfirmed, setIsConfirmed] = useState(false)
  const [isFadingOut, setIsFadingOut] = useState(false)

  // Handle checkbox change with delayed fade-out
  const handleConfirmationChange = (checked: boolean) => {
    setIsConfirmed(checked)
    if (checked && confirmationText) {
      // Wait 500ms, then start fading out
      setTimeout(() => {
        setIsFadingOut(true)
        // After 1s fade animation, hide completely
        setTimeout(() => {
          setIsVisible(false)
        }, 1000)
      }, 250)
    }
  }

  // Hide the admonition when not visible or when closed
  if (!isVisible) return null

  const config = admonitionConfig[type]
  const Icon = config.icon
  const displayTitle = title || config.defaultTitle

  // Determine content to display: description prop takes priority, then children
  const contentToDisplay = description || children

  return (
    <div
      className={cn(
        "rounded-md border p-3 text-sm flex items-start gap-2 transition-opacity duration-1000",
        config.bgColor,
        config.borderColor,
        config.textColor,
        isFadingOut && "opacity-0",
        className
      )}
    >
      <Icon className={cn("size-4 mt-0.5 flex-shrink-0", config.iconColor)} />
      <div className="flex-1">
        <div>
          <div className="text-md font-bold mb-2">
            {title ? <InlineMarkdown>{displayTitle}</InlineMarkdown> : displayTitle}
          </div>
          {typeof contentToDisplay === "string" ? (
            <InlineMarkdown>{contentToDisplay}</InlineMarkdown>
          ) : (
            contentToDisplay
          )}
        </div>
        
        {confirmationText && (
          <label className={`flex items-center gap-2 mt-2 cursor-pointer hover:opacity-80 transition-opacity pt-2 border-t ${config.separatorColor}`}>
            <input
              type="checkbox"
              checked={isConfirmed}
              onChange={(e) => handleConfirmationChange(e.target.checked)}
              className="cursor-pointer"
            />
            <span className="text-sm">
              <InlineMarkdown>{confirmationText}</InlineMarkdown>
            </span>
          </label>
        )}
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

