import { useState, useEffect, useId, useMemo } from "react"
import { X, Info, AlertTriangle, AlertCircle, CheckCircle } from "lucide-react"
import { cn } from "@/lib/utils"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { shouldShowAlert, setDontShowAgain as saveHidePreference } from "@/lib/localStorage"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useTemplateContext } from "@/contexts/useRunbook"
import { resolveTemplateReferences } from "@/lib/templateUtils"

export type AdmonitionType = "note" | "info" | "warning" | "danger"

interface AdmonitionProps {
  type: AdmonitionType
  title?: string
  description?: string
  closable?: boolean
  confirmationText?: string
  /** Reference to one or more Inputs by ID for template expressions in props */
  inputsId?: string | string[]
  allowPermanentHide?: boolean
  storageKey?: string
  children?: React.ReactNode
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
    bgColor: "bg-muted",
    borderColor: "border-border",
    textColor: "text-foreground",
    iconColor: "text-muted-foreground",
    defaultTitle: "Note",
  },
  info: {
    icon: Info,
    bgColor: "bg-info-muted",
    borderColor: "border-info/40",
    textColor: "text-info",
    iconColor: "text-info",
    defaultTitle: "Info",
  },
  warning: {
    icon: AlertTriangle,
    bgColor: "bg-warning-muted",
    borderColor: "border-warning/30",
    textColor: "text-warning-foreground",
    iconColor: "text-warning",
    defaultTitle: "Warning",
  },
  danger: {
    icon: AlertCircle,
    bgColor: "bg-destructive-muted",
    borderColor: "border-destructive/30",
    textColor: "text-destructive",
    iconColor: "text-destructive",
    defaultTitle: "Danger",
  },
}

const VALID_ADMONITION_TYPES = Object.keys(admonitionConfig) as AdmonitionType[]

export function Admonition({
  type,
  title,
  description,
  children,
  closable = false,
  confirmationText,
  inputsId,
  allowPermanentHide = false,
  storageKey,
  className,
}: AdmonitionProps) {
  // Resolve template expressions in display props
  const templateCtx = useTemplateContext(inputsId)
  const resolvedTitle = useMemo(() => title ? resolveTemplateReferences(title, templateCtx) : title, [title, templateCtx])
  const resolvedDescription = useMemo(() => description ? resolveTemplateReferences(description, templateCtx) : description, [description, templateCtx])
  const resolvedConfirmationText = useMemo(() => confirmationText ? resolveTemplateReferences(confirmationText, templateCtx) : confirmationText, [confirmationText, templateCtx])
  const [isVisible, setIsVisible] = useState(true)
  const [isConfirmed, setIsConfirmed] = useState(false)
  const [isFadingOut, setIsFadingOut] = useState(false)
  const [dontShowAgain, setDontShowAgain] = useState(false)
  const componentId = useId()
  const { reportError, clearError } = useErrorReporting()

  // Check localStorage on mount to see if user has permanently hidden this
  useEffect(() => {
    if (allowPermanentHide && storageKey) {
      if (!shouldShowAlert(`admonition_hide_${storageKey}`)) {
        setIsVisible(false)
      }
    }
  }, [allowPermanentHide, storageKey])

  // Report invalid admonition type to error tracking
  useEffect(() => {
    if (!admonitionConfig[type]) {
      const validTypes = VALID_ADMONITION_TYPES.map((t) => `"${t}"`).join(", ")
      reportError({
        componentId,
        componentType: 'Admonition',
        severity: 'error',
        message: `Invalid admonition type "${String(type)}". Valid types are: ${validTypes}.`,
      })
    } else {
      clearError(componentId)
    }
  }, [type, componentId, reportError, clearError])

  // Handle checkbox change with delayed fade-out
  const handleConfirmationChange = (checked: boolean) => {
    setIsConfirmed(checked)
    if (checked && confirmationText) {
      // If "don't show again" is checked, store in localStorage
      if (dontShowAgain && allowPermanentHide && storageKey) {
        saveHidePreference(`admonition_hide_${storageKey}`)
      }

      // Wait 250ms, then start fading out
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

  if (!config) {
    const validTypes = VALID_ADMONITION_TYPES.map((t) => `"${t}"`).join(", ")
    return (
      <div
        className={cn(
          "runbook-block rounded-md border p-3 text-sm flex items-start gap-2 mb-5",
          "bg-destructive-muted border-destructive/30 text-destructive"
        )}
      >
        <AlertCircle className="size-4 mt-0.5 flex-shrink-0 text-destructive" />
        <div>
          <div className="text-md font-bold mb-1">Invalid Admonition Type</div>
          <p>
            Unknown type <code className="bg-destructive-muted px-1 rounded">"{String(type)}"</code>.
            Valid types are: {validTypes}.
          </p>
        </div>
      </div>
    )
  }

  const Icon = config.icon
  const displayTitle = resolvedTitle || config.defaultTitle

  // Determine content to display: description prop takes priority, then children
  const contentToDisplay = resolvedDescription || children

  return (
    <div
      className={cn(
        "runbook-block rounded-md border p-3 text-sm flex items-start gap-2 transition-opacity duration-1000 mb-5",
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
            {resolvedTitle ? <InlineMarkdown>{displayTitle}</InlineMarkdown> : displayTitle}
          </div>
          {typeof contentToDisplay === "string" ? (
            <InlineMarkdown>{contentToDisplay}</InlineMarkdown>
          ) : (
            contentToDisplay
          )}
        </div>
        
        {resolvedConfirmationText && (
          <div className="mt-3">
            <button
              onClick={() => handleConfirmationChange(true)}
              disabled={isConfirmed}
              className="px-4 py-2 text-sm font-medium bg-warning text-white rounded-md hover:bg-warning/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <InlineMarkdown>{resolvedConfirmationText}</InlineMarkdown>
            </button>
            
            {allowPermanentHide && storageKey && (
              <div className="mt-3">
                <label className={`flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity opacity-80`}>
                  <input
                    type="checkbox"
                    checked={dontShowAgain}
                    onChange={(e) => setDontShowAgain(e.target.checked)}
                    className="cursor-pointer"
                  />
                  <span className="text-sm text-muted-foreground">
                    Don't show me this again
                  </span>
                </label>
              </div>
            )}
          </div>
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

// Set displayName for React DevTools and component detection
Admonition.displayName = 'Admonition';

export default Admonition

