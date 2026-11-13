import { useState, useEffect, useId, useMemo, useRef, type RefObject } from "react"
import { X, Info, AlertTriangle, AlertCircle, CheckCircle, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { InlineMarkdown } from "@/components/mdx/_shared/components/InlineMarkdown"
import { MarkdownChildren } from "@/components/mdx/_shared/components/MarkdownChildren"
import { shouldShowAlert, setDontShowAgain as saveHidePreference } from "@/lib/localStorage"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useRunbookContext, useTemplateContext } from "@/contexts/useRunbook"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useSessionHistory } from "@/contexts/useSessionHistory"
import { parseSavedConfirmation, type SavedConfirmation } from "@/lib/sessionHistory"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import type { AppError } from "@/types/error"
import { DuplicateIdError } from "@/components/mdx/_shared/components/DuplicateIdError"
import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import { ProgressStep } from "@/components/mdx/_shared/components/ProgressStep"
import {
  CONFIRMED_OUTPUT,
  GATE_PURPOSE,
  gateProblem,
} from "../../../../../src/domain/admonition/gate"

export type AdmonitionType = "note" | "info" | "warning" | "danger"

interface AdmonitionProps {
  /**
   * Makes the confirmation an output, `CONFIRMED`, that later blocks can wait
   * on. Needs `confirmationText`.
   */
  id?: string
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
    /** Colors for the confirmation button; text must stay legible on the fill */
    buttonColor: string
    defaultTitle: string
  }
> = {
  note: {
    icon: CheckCircle,
    bgColor: "bg-muted",
    borderColor: "border-border",
    textColor: "text-foreground",
    iconColor: "text-muted-foreground",
    buttonColor: "bg-primary text-primary-foreground hover:bg-primary/90",
    defaultTitle: "Note",
  },
  info: {
    icon: Info,
    bgColor: "bg-info-muted",
    borderColor: "border-info/40",
    textColor: "text-info",
    iconColor: "text-info",
    buttonColor: "bg-info text-info-foreground hover:bg-info/90",
    defaultTitle: "Info",
  },
  warning: {
    icon: AlertTriangle,
    bgColor: "bg-warning-muted",
    borderColor: "border-warning/30",
    textColor: "text-warning-foreground",
    iconColor: "text-warning",
    buttonColor: "bg-destructive text-white hover:bg-destructive/90",
    defaultTitle: "Warning",
  },
  danger: {
    icon: AlertCircle,
    bgColor: "bg-destructive-muted",
    borderColor: "border-destructive/30",
    textColor: "text-destructive",
    iconColor: "text-destructive",
    buttonColor: "bg-destructive text-white hover:bg-destructive/90",
    defaultTitle: "Danger",
  },
}

const VALID_ADMONITION_TYPES = Object.keys(admonitionConfig) as AdmonitionType[]

/**
 * A callout: a note, info, warning or danger message. With `confirmationText`
 * it has a button the user clicks to confirm they read it or did what it asks.
 * With an `id` too, the confirmation is an output later blocks can wait on.
 */
export function Admonition(props: AdmonitionProps) {
  return props.id === undefined ? (
    <Callout {...props} />
  ) : (
    <GatedAdmonition {...props} id={props.id} />
  )
}

/** What's wrong with a gated Admonition's props, if anything. */
function gateError(props: AdmonitionProps & { id: string }): AppError | null {
  const problem = gateProblem(props)
  return problem
    ? { message: `The <Admonition id="${props.id}"> block ${problem}`, details: GATE_PURPOSE }
    : null
}

/** An Admonition whose confirmation sets an output, and stays confirmed when the session resumes. */
function GatedAdmonition(props: AdmonitionProps & { id: string }) {
  const { id } = props
  const blockRef = useRef<HTMLDivElement>(null)
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(
    id,
    "Admonition",
    blockRef,
  )
  const history = useSessionHistory()
  const { registerOutputs } = useRunbookContext()
  const [confirmed, setConfirmed] = useState(
    () => parseSavedConfirmation(history.saved(id, "confirmation")) !== undefined,
  )

  useEffect(() => {
    if (confirmed && id) registerOutputs(id, { [CONFIRMED_OUTPUT]: "true" })
  }, [confirmed, id, registerOutputs])

  const error = gateError(props)
  if (error) return <ErrorDisplay error={error} />
  if (isDuplicate) {
    return (
      <DuplicateIdError
        id={id}
        isNormalizedCollision={isNormalizedCollision}
        collidingId={collidingId}
      />
    )
  }

  const confirm = () => {
    setConfirmed(true)
    history.record(id, "confirmation", { confirmed: true } satisfies SavedConfirmation)
  }
  return (
    <>
      <ProgressStep done={confirmed} />
      <Callout {...props} gate={{ confirmed, confirm, blockRef }} />
    </>
  )
}

interface CalloutProps extends AdmonitionProps {
  /** A gated Admonition's confirmation, which stays shown once given rather than fading out. */
  gate?: { confirmed: boolean; confirm: () => void; blockRef: RefObject<HTMLDivElement | null> }
}

function Callout({
  id,
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
  gate,
}: CalloutProps) {
  // Resolve template expressions in display props
  const templateCtx = useTemplateContext(inputsId)
  const resolvedTitle = useMemo(
    () => (title ? resolveTemplateReferences(title, templateCtx) : title),
    [title, templateCtx],
  )
  const resolvedDescription = useMemo(
    () => (description ? resolveTemplateReferences(description, templateCtx) : description),
    [description, templateCtx],
  )
  const resolvedConfirmationText = useMemo(
    () =>
      confirmationText
        ? resolveTemplateReferences(confirmationText, templateCtx)
        : confirmationText,
    [confirmationText, templateCtx],
  )
  // Check localStorage on mount to see if user has permanently hidden this
  const [isVisible, setIsVisible] = useState(
    () => !(allowPermanentHide && storageKey) || shouldShowAlert(`admonition_hide_${storageKey}`),
  )
  const [isConfirmed, setIsConfirmed] = useState(false)
  const [isFadingOut, setIsFadingOut] = useState(false)
  const [dontShowAgain, setDontShowAgain] = useState(false)
  const componentId = useId()
  const { reportError, clearError } = useErrorReporting()

  // Report invalid admonition type to error tracking
  useEffect(() => {
    if (!admonitionConfig[type]) {
      const validTypes = VALID_ADMONITION_TYPES.map((t) => `"${t}"`).join(", ")
      reportError({
        componentId,
        componentType: "Admonition",
        severity: "error",
        message: `Invalid admonition type "${String(type)}". Valid types are: ${validTypes}.`,
      })
    } else {
      clearError(componentId)
    }
  }, [type, componentId, reportError, clearError])

  // Handle the confirmation button click with delayed fade-out
  const handleConfirm = () => {
    if (gate) {
      gate.confirm()
      return
    }
    setIsConfirmed(true)

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

  if (!isVisible) return null

  const config = admonitionConfig[type]

  if (!config) {
    const validTypes = VALID_ADMONITION_TYPES.map((t) => `"${t}"`).join(", ")
    return (
      <div
        className={cn(
          "runbook-block rounded-md border p-3 text-sm flex items-start gap-2 mb-5",
          "bg-destructive-muted border-destructive/30 text-destructive",
        )}
      >
        <AlertCircle className="size-4 mt-0.5 flex-shrink-0 text-destructive" />
        <div>
          <div className="text-md font-bold mb-1">Invalid Admonition Type</div>
          <p>
            Unknown type <code className="bg-destructive-muted px-1 rounded">"{String(type)}"</code>
            . Valid types are: {validTypes}.
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
      ref={gate?.blockRef}
      data-testid={id}
      className={cn(
        "runbook-block rounded-md border p-3 text-sm flex items-start gap-2 transition-opacity duration-1000 mb-5",
        config.bgColor,
        config.borderColor,
        config.textColor,
        isFadingOut && "opacity-0",
        className,
      )}
    >
      <Icon className={cn("size-4 mt-0.5 flex-shrink-0", config.iconColor)} />
      <div className="flex-1 min-w-0">
        <div>
          <div className="text-md font-bold mb-2">
            {resolvedTitle ? <InlineMarkdown>{displayTitle}</InlineMarkdown> : displayTitle}
          </div>
          {typeof contentToDisplay === "string" ? (
            <InlineMarkdown>{contentToDisplay}</InlineMarkdown>
          ) : (
            contentToDisplay && <MarkdownChildren>{contentToDisplay}</MarkdownChildren>
          )}
        </div>

        {gate?.confirmed ? (
          <div className="mt-3 flex items-center gap-1.5 font-medium">
            <Check className="size-4" />
            Confirmed
          </div>
        ) : (
          resolvedConfirmationText && (
            <div className="mt-3">
              <button
                onClick={handleConfirm}
                disabled={isConfirmed}
                className={cn(
                  "px-4 py-2 text-sm font-medium rounded-md transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed",
                  config.buttonColor,
                )}
              >
                <InlineMarkdown>{resolvedConfirmationText}</InlineMarkdown>
              </button>

              {allowPermanentHide && storageKey && (
                <div className="mt-3">
                  <label
                    className={`flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity opacity-80`}
                  >
                    <input
                      type="checkbox"
                      checked={dontShowAgain}
                      onChange={(e) => setDontShowAgain(e.target.checked)}
                      className="cursor-pointer"
                    />
                    <span className="text-sm text-muted-foreground">Don't show me this again</span>
                  </label>
                </div>
              )}
            </div>
          )
        )}
      </div>
      {closable && (
        <button
          onClick={() => setIsVisible(false)}
          className={cn(
            "flex-shrink-0 hover:opacity-70 transition-opacity cursor-pointer",
            config.iconColor,
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
Admonition.displayName = "Admonition"
