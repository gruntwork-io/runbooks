import { useEffect, useMemo, useRef } from "react"
import { CheckCircle, KeyRound, Loader2, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  BlockIdLabel,
  InlineMarkdown,
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
import {
  extractTemplateDependenciesFromString,
  requireAllOutputs,
} from "@/lib/extractTemplateDependencies"
import { encodeOutputs } from "@/lib/outputValues"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import type { AppError } from "@/types/error"
import { onePasswordItemRequestError } from "../../../../../src/domain/onepassword/item"
import { OnePasswordItemInstruction } from "./OnePasswordItemInstruction"
import { useOnePasswordItem } from "./hooks/useOnePasswordItem"
import type { OnePasswordItemProps, OnePasswordItemStatus } from "./types"

const DEFAULT_TITLE = "Save to 1Password"
/** Shown in place of a concealed value. Fixed length, so it doesn't reveal the value's. */
const MASK = "••••••••"

const STATUS_STYLES: Record<
  OnePasswordItemStatus,
  { bg: string; icon: typeof KeyRound; color: string }
> = {
  ready: { bg: "bg-muted border-border", icon: KeyRound, color: "text-muted-foreground" },
  saving: { bg: "bg-info-muted border-info/40", icon: Loader2, color: "text-info" },
  success: { bg: "bg-success-muted border-success/30", icon: CheckCircle, color: "text-success" },
  fail: {
    bg: "bg-destructive-muted border-destructive/30",
    icon: XCircle,
    color: "text-destructive",
  },
}

const NO_TAGS: string[] = []
const NO_FIELDS: NonNullable<OnePasswordItemProps["fields"]> = []

function OnePasswordItemInteractive({
  id,
  title,
  description,
  vault,
  itemTitle,
  category = "Login",
  username,
  password,
  url,
  notes,
  tags = NO_TAGS,
  fields = NO_FIELDS,
  account,
  inputsId,
  autoCollapse,
}: OnePasswordItemProps) {
  const blockRef = useRef<HTMLDivElement>(null)
  const { isDuplicate, isNormalizedCollision, collidingId } = useComponentIdRegistry(
    id,
    "OnePasswordItem",
    blockRef,
  )
  const { reportError, clearError } = useErrorReporting()

  // Everything the item holds waits for every value it names.
  const blockingDeps = useMemo(
    () =>
      requireAllOutputs(
        extractTemplateDependenciesFromString(
          vault ?? "",
          itemTitle ?? "",
          username ?? "",
          password ?? "",
          url ?? "",
          notes ?? "",
          account ?? "",
          ...tags,
          ...fields.flatMap((field) => [field.label ?? "", field.value ?? ""]),
        ),
      ),
    [vault, itemTitle, username, password, url, notes, account, tags, fields],
  )
  const { unmetInputDeps, unmetOutputDeps, hasAllDependencies, inputs, outputs } =
    useTemplateDependencies(blockingDeps, inputsId)
  const templateCtx = useMemo(() => ({ inputs, outputs }), [inputs, outputs])
  // For display only: a sensitive output shows as <redacted>.
  const show = (value: string | undefined) =>
    value ? resolveTemplateReferences(value, templateCtx) : ""

  const validationError = useMemo((): AppError | null => {
    if (!id) {
      return {
        message: "The <OnePasswordItem> component requires a non-empty 'id' prop.",
        details: "Please provide a unique 'id' for this component instance.",
      }
    }
    const invalid = onePasswordItemRequestError({ vault, title: itemTitle, category, fields })
    return invalid
      ? { message: invalid, details: "Fix the <OnePasswordItem> block's props in the runbook." }
      : null
  }, [id, vault, itemTitle, category, fields])

  useEffect(() => {
    if (isDuplicate) {
      reportError({
        componentId: id,
        componentType: "OnePasswordItem",
        severity: "error",
        message: `Duplicate OnePasswordItem block ID: "${id}"`,
      })
    } else if (isNormalizedCollision) {
      reportError({
        componentId: id,
        componentType: "OnePasswordItem",
        severity: "error",
        message: `OnePasswordItem ID "${id}" collides with "${collidingId}" after normalization`,
      })
    } else {
      clearError(id)
    }
  }, [id, isDuplicate, isNormalizedCollision, collidingId, reportError, clearError])

  const { status, outputs: itemOutputs, error, save } = useOnePasswordItem(id)

  if (validationError) return <ErrorDisplay error={validationError} />
  if (isDuplicate || isNormalizedCollision) return null

  const { bg, icon: Icon, color } = STATUS_STYLES[status]
  const done = status === "success"
  const canSave = hasAllDependencies && status !== "saving" && !done

  // MAIN renders the templates, so the values sent are the raw props plus
  // what they reference, each output marked if it's sensitive.
  const handleSave = () =>
    void save({
      item: {
        vault,
        title: itemTitle,
        category,
        ...(username !== undefined ? { username } : {}),
        ...(password !== undefined ? { password } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(account !== undefined ? { account } : {}),
        tags,
        fields: fields.map((field) => ({
          label: field.label,
          value: field.value,
          ...(field.type ? { type: field.type } : {}),
        })),
      },
      templateInputs: inputs,
      templateOutputs: Object.fromEntries(
        Object.entries(outputs).map(([block, values]) => [block, encodeOutputs(values)]),
      ),
    })

  const rows: Array<[string, string, boolean?]> = [
    ["Vault", show(vault)],
    ["Title", show(itemTitle)],
    ["Category", category],
    ...(username ? [["Username", show(username)] as [string, string]] : []),
    ...(password ? [["Password", MASK, true] as [string, string, boolean]] : []),
    ...(url ? [["Website", show(url)] as [string, string]] : []),
    ...fields.map((field): [string, string, boolean] => [
      show(field.label),
      (field.type ?? "concealed") === "concealed" ? MASK : show(field.value),
      true,
    ]),
    ...(notes ? [["Notes", show(notes)] as [string, string]] : []),
    ...(tags.length ? [["Tags", tags.map(show).join(", ")] as [string, string]] : []),
  ]

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
            <Icon className={`size-6 ${color} ${status === "saving" ? "animate-spin" : ""}`} />
          </div>

          <div data-fold="path" className="flex-1 min-w-0 space-y-3">
            <div data-fold="title" className="text-md font-bold text-foreground">
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

            {!hasAllDependencies && (
              <UnmetDependenciesWarning
                blockType="item"
                unmetInputDeps={unmetInputDeps}
                unmetOutputDeps={unmetOutputDeps}
              />
            )}

            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm m-0">
              {rows.map(([label, value, mono], i) => (
                <div key={`${label}-${i}`} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className={`m-0 break-all ${mono ? "font-mono" : ""}`}>{value || "—"}</dd>
                </div>
              ))}
            </dl>

            {error && status === "fail" && (
              <div className="p-3 bg-destructive-muted border border-destructive/30 rounded-md flex items-start gap-2">
                <XCircle className="size-4 text-destructive mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-destructive m-0">The item wasn't saved</p>
                  <p className="text-xs text-destructive m-0 mt-0.5">{error}</p>
                </div>
              </div>
            )}

            {done && itemOutputs && (
              <p className="text-sm m-0">
                Saved &ldquo;{itemOutputs.OP_ITEM_TITLE}&rdquo; to the {itemOutputs.OP_VAULT} vault.
              </p>
            )}

            {!done && (
              <Button type="button" disabled={!canSave} onClick={handleSave}>
                {status === "saving"
                  ? "Saving... (approve in 1Password)"
                  : status === "fail"
                    ? "Try again"
                    : "Save to 1Password"}
              </Button>
            )}
          </div>
        </div>

        {itemOutputs && (
          <div className="mt-4">
            <ViewOutputs outputs={itemOutputs} autoOpen={done} />
          </div>
        )}
      </div>
    </AutoCollapse>
  )
}

/**
 * Saves an item to a 1Password vault with the 1Password CLI. In instruction
 * mode it shows the `op item create` command instead, and saves nothing.
 */
function OnePasswordItem(props: OnePasswordItemProps) {
  const { enabled: instructionMode } = useInstructionMode()
  if (instructionMode) return <OnePasswordItemInstruction {...props} />
  return <OnePasswordItemInteractive {...props} />
}

OnePasswordItem.displayName = "OnePasswordItem"

export { OnePasswordItem }
export default OnePasswordItem
