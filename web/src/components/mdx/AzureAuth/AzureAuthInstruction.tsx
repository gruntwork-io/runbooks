import { LogIn } from "lucide-react"
import { Instruction } from "@/components/mdx/_shared"
import { useTemplateContext } from "@/contexts/useRunbook"
import { resolveTemplateReferences } from "@/lib/templateUtils"
import type { AzureAuthProps } from "./types"

/**
 * Instruction-mode rendering of an AzureAuth block: a plain "Sign in to
 * Azure" instruction with the pinned tenant and subscription. Nothing signs in.
 * A separate component so useAzureAuth (which detects sign-ins on mount)
 * never runs in instruction mode.
 */
export function AzureAuthInstruction({
  id,
  description,
  tenantId,
  subscriptionId,
  requiredRoles,
  inputsId,
  autoCollapse,
}: AzureAuthProps) {
  const templateCtx = useTemplateContext(inputsId)
  const resolve = (value: string | undefined) =>
    value ? resolveTemplateReferences(value, templateCtx) : undefined

  const tenant = resolve(tenantId)
  const subscription = resolve(subscriptionId)
  const hints: { label: string; value: string }[] = []
  if (tenant) hints.push({ label: "Tenant", value: tenant })
  if (subscription) hints.push({ label: "Subscription", value: subscription })
  for (const role of requiredRoles ?? []) {
    hints.push({ label: "Required role", value: `${role.role} at ${role.scope ?? "subscription"}` })
  }

  return (
    <Instruction
      id={id}
      autoCollapse={autoCollapse}
      icon={LogIn}
      title={tenant ? `Sign in to Azure in tenant \`${tenant}\`` : "Sign in to Azure"}
      description={resolve(description)}
      note={
        hints.length > 0 ? (
          <ul className="list-disc ml-5 space-y-0.5">
            {hints.map(({ label, value }) => (
              <li key={`${label}:${value}`}>
                {label}: <code className="font-mono">{value}</code>
              </li>
            ))}
          </ul>
        ) : undefined
      }
    />
  )
}
