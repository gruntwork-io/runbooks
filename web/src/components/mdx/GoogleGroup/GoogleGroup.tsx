import { useEffect, useMemo, useRef } from "react"
import { CheckCircle, Loader2, Users, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  BlockIdLabel,
  InlineMarkdown,
  UnmetAuthDependencyWarning,
  UnmetDependenciesWarning,
  ViewOutputs,
} from "@/components/mdx/_shared"
import { AutoCollapse, CollapseButton } from "@/components/mdx/_shared/components/AutoCollapse"
import { ErrorDisplay } from "@/components/mdx/_shared/components/ErrorDisplay"
import { ProgressStep } from "@/components/mdx/_shared/components/ProgressStep"
import { useTemplateDependencies } from "@/components/mdx/_shared/hooks/useTemplateDependencies"
import { useComponentIdRegistry } from "@/contexts/ComponentIdRegistry"
import { useErrorReporting } from "@/contexts/useErrorReporting"
import { useInstructionMode } from "@/contexts/useInstructionMode"
import { useAllOutputs } from "@/contexts/useRunbook"
import {
  extractTemplateDependenciesFromString,
  requireAllOutputs,
} from "@/lib/extractTemplateDependencies"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import { normalizeBlockId } from "@/lib/utils"
import type { AppError } from "@/types/error"
import { googleGroupRequestError } from "../../../../../src/domain/google/groups"
import { GoogleCloudMark } from "../GoogleAuth/components/GoogleCloudLogo"
import { GoogleGroupInstruction } from "./GoogleGroupInstruction"
import { useGoogleGroup } from "./hooks/useGoogleGroup"
import type { GoogleGroupProps, GoogleGroupStatus } from "./types"

const DEFAULT_TITLE = "Create a Google group"

const STATUS_STYLES: Record<GoogleGroupStatus, { bg: string; icon: typeof Users; color: string }> =
  {
    ready: { bg: "bg-muted border-border", icon: Users, color: "text-muted-foreground" },
    creating: { bg: "bg-info-muted border-info/40", icon: Loader2, color: "text-info" },
    success: { bg: "bg-success-muted border-success/30", icon: CheckCircle, color: "text-success" },
    fail: {
      bg: "bg-destructive-muted border-destructive/30",
      icon: XCircle,
      color: "text-destructive",
    },
  }

function GoogleGroupInteractive({
  id,
  title,
  description,
  googleAuthId,
  email,
  displayName = "",
  groupDescription = "",
  customerId = "",
  members = [],
  role = "MEMBER",
  allowExternalSenders = false,
  inputsId,
  autoCollapse,
}: GoogleGroupProps) {
  const blockRef = useRef<HTMLDivElement>(null)
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(
    id,
    "GoogleGroup",
    blockRef,
  )
  const { reportError, clearError } = useErrorReporting()

  // The props that decide what is created wait for every value they name.
  const blockingDeps = useMemo(
    () =>
      requireAllOutputs(
        extractTemplateDependenciesFromString(
          email,
          displayName,
          groupDescription,
          customerId,
          ...members,
        ),
      ),
    [email, displayName, groupDescription, customerId, members],
  )
  const { unmetInputDeps, unmetOutputDeps, hasAllDependencies, inputs, outputs } =
    useTemplateDependencies(blockingDeps, inputsId)
  const templateCtx = useMemo(() => ({ inputs, outputs }), [inputs, outputs])
  const resolve = (value: string) => resolveTemplateReferences(value, templateCtx).trim()

  const request = {
    email: resolve(email),
    displayName: resolve(displayName),
    groupDescription: resolve(groupDescription),
    customerId: resolve(customerId),
    members: members.map(resolve).filter(Boolean),
  }

  // A missing id, or a prop the author got wrong, is a configuration error.
  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <GoogleGroup> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance.",
      }
    }
    if (!email) {
      return {
        message: "The <GoogleGroup> component requires an 'email' prop.",
        details: "Set 'email' to the address the new group should have.",
      }
    }
    const invalidRole = googleGroupRequestError({ email: "group@example.com", role })
    return invalidRole
      ? { message: invalidRole, details: "Set 'role' to MEMBER, MANAGER, or OWNER." }
      : null
  }, [id, email, role])

  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: "GoogleGroup",
        severity: "error",
        message: `Duplicate GoogleGroup block ID: "${id}"`,
      })
    } else if (isNormalizedCollision) {
      reportError({
        componentId: id,
        componentType: "GoogleGroup",
        severity: "error",
        message: `GoogleGroup ID "${id}" collides with "${collidingId}" after normalization`,
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, isNormalizedCollision, collidingId, reportError, clearError])

  const allOutputs = useAllOutputs()
  const authMet =
    !googleAuthId || allOutputs[normalizeBlockId(googleAuthId)]?.values.__AUTHENTICATED === "true"

  const { status, log, outputs: groupOutputs, error, create } = useGoogleGroup(id)

  if (validationError) return <ErrorDisplay error={validationError} />
  if (isDuplicate || isNormalizedCollision) return null

  // Once every value is in, an address that still isn't one is the user's to fix.
  const requestError = hasAllDependencies
    ? googleGroupRequestError({ email: request.email, members: request.members })
    : undefined
  const canCreate =
    authMet && hasAllDependencies && !requestError && status !== "creating" && status !== "success"
  const { bg, icon: Icon, color } = STATUS_STYLES[status]
  const done = status === "success"

  return (
    <AutoCollapse enabled={autoCollapse} done={done}>
      <div
        ref={blockRef}
        data-fold="path"
        data-testid={id}
        className={`runbook-block relative rounded-sm border ${bg} mb-5 p-4`}
      >
        <ProgressStep done={done} />

        <div data-fold="keep" className="absolute top-3 right-3 z-20 flex items-center gap-1">
          <BlockIdLabel id={id} size="large" />
          <CollapseButton />
        </div>

        <div data-fold="path" className="flex @container">
          <div
            data-fold="keep"
            className="border-r border-border pr-2 mr-4 flex flex-col items-center"
          >
            <Icon className={`size-6 ${color} ${status === "creating" ? "animate-spin" : ""}`} />
          </div>

          <div data-fold="path" className="flex-1 min-w-0 space-y-3">
            <div
              data-fold="title"
              className="flex items-center gap-2 text-md font-bold text-foreground"
            >
              <GoogleCloudMark className="size-5" />
              <InlineMarkdown>
                {resolveTemplateReferences(title ?? DEFAULT_TITLE, templateCtx)}
              </InlineMarkdown>
            </div>
            {description && (
              <div className="text-md text-muted-foreground">
                <InlineMarkdown>
                  {resolveTemplateReferences(description, templateCtx)}
                </InlineMarkdown>
              </div>
            )}

            {!authMet && googleAuthId && (
              <UnmetAuthDependencyWarning
                dependency={{ blockId: googleAuthId }}
                heading="Waiting for Google authentication:"
                hint="Sign in with this GoogleAuth block first."
              />
            )}
            {!hasAllDependencies && (
              <UnmetDependenciesWarning
                blockType="group"
                unmetInputDeps={unmetInputDeps}
                unmetOutputDeps={unmetOutputDeps}
              />
            )}

            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm m-0">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="m-0 font-mono break-all">{request.email || "—"}</dd>
              <dt className="text-muted-foreground">Name</dt>
              <dd className="m-0">{request.displayName || request.email.split("@")[0] || "—"}</dd>
              {request.groupDescription && (
                <>
                  <dt className="text-muted-foreground">Description</dt>
                  <dd className="m-0">{request.groupDescription}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Owner</dt>
              <dd className="m-0">The account you signed in with</dd>
              {request.members.length > 0 && (
                <>
                  <dt className="text-muted-foreground">
                    {role === "MEMBER" ? "Members" : `${role[0]}${role.slice(1).toLowerCase()}s`}
                  </dt>
                  <dd className="m-0 font-mono break-all">{request.members.join(", ")}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Outside senders</dt>
              <dd className="m-0">
                {allowExternalSenders ? "Can email the group" : "Your organization's default"}
              </dd>
            </dl>

            {requestError && <p className="text-sm text-destructive m-0">{requestError}</p>}

            {error && status === "fail" && (
              <div className="p-3 bg-destructive-muted border border-destructive/30 rounded-md flex items-start gap-2">
                <XCircle className="size-4 text-destructive mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-destructive m-0">
                    The group wasn't created
                  </p>
                  <p className="text-xs text-destructive m-0 mt-0.5">{error}</p>
                </div>
              </div>
            )}

            {log.length > 0 && (
              <ul className="text-sm m-0 pl-5 list-disc">
                {log.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}

            {!done && (
              <Button
                type="button"
                disabled={!canCreate}
                onClick={() =>
                  void create({
                    ...(googleAuthId ? { googleAuthId } : {}),
                    email: request.email,
                    ...(request.displayName ? { displayName: request.displayName } : {}),
                    ...(request.groupDescription ? { description: request.groupDescription } : {}),
                    ...(request.customerId ? { customerId: request.customerId } : {}),
                    members: request.members,
                    role,
                    allowExternalSenders,
                  })
                }
              >
                {status === "creating"
                  ? "Creating..."
                  : status === "fail"
                    ? "Try again"
                    : "Create group"}
              </Button>
            )}
          </div>
        </div>

        {groupOutputs && (
          <div className="mt-4">
            <ViewOutputs outputs={groupOutputs} autoOpen={done} />
          </div>
        )}
      </div>
    </AutoCollapse>
  )
}

/**
 * Creates a Google group and adds its members, as a GoogleAuth block's
 * credential. In instruction mode it shows the gcloud commands instead, and
 * calls nothing.
 */
function GoogleGroup(props: GoogleGroupProps) {
  const { enabled: instructionMode } = useInstructionMode()
  if (instructionMode) return <GoogleGroupInstruction {...props} />
  return <GoogleGroupInteractive {...props} />
}

GoogleGroup.displayName = "GoogleGroup"

export { GoogleGroup }
export default GoogleGroup
