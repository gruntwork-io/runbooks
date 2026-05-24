import { useMemo } from 'react'
import { LogIn } from 'lucide-react'
import { Instruction } from '@/components/mdx/_shared'
import { useTemplateContext } from '@/contexts/useRunbook'
import { resolveTemplateReferences } from '@/lib/templateUtils'
import type { AwsAuthProps } from './types'

/**
 * Instruction-mode rendering of an AwsAuth block (spec §6.4): a plain "Log into
 * AWS" instruction. No SSO/profile/static-key UI, no credential capture, no
 * commands. The account qualifier is taken from `ssoAccountId` when known.
 *
 * This is a separate component (not a branch inside AwsAuth) so the interactive
 * path's `useAwsAuth` hook — which kicks off credential detection on mount — is
 * never invoked while the mode is on.
 */
export function AwsAuthInstruction({
  id,
  description,
  ssoStartUrl,
  ssoRegion,
  ssoAccountId,
  ssoRoleName,
  inputsId,
}: AwsAuthProps) {
  const templateCtx = useTemplateContext(inputsId)

  const account = useMemo(
    () => (ssoAccountId ? resolveTemplateReferences(ssoAccountId, templateCtx) : undefined),
    [ssoAccountId, templateCtx],
  )
  const resolvedDescription = useMemo(
    () => (description ? resolveTemplateReferences(description, templateCtx) : undefined),
    [description, templateCtx],
  )
  const resolvedStartUrl = useMemo(
    () => (ssoStartUrl ? resolveTemplateReferences(ssoStartUrl, templateCtx) : undefined),
    [ssoStartUrl, templateCtx],
  )
  const resolvedRole = useMemo(
    () => (ssoRoleName ? resolveTemplateReferences(ssoRoleName, templateCtx) : undefined),
    [ssoRoleName, templateCtx],
  )

  const heading = account
    ? `Log into AWS in the \`${account}\` account`
    : 'Log into AWS'

  // Surface the configured SSO details so the user can reproduce the login by
  // hand. These are hints, not commands — nothing here authenticates the app.
  const hints: { label: string; value: string }[] = []
  if (resolvedStartUrl) hints.push({ label: 'SSO start URL', value: resolvedStartUrl })
  if (ssoRegion) hints.push({ label: 'SSO region', value: ssoRegion })
  if (resolvedRole) hints.push({ label: 'Role', value: resolvedRole })

  return (
    <Instruction
      id={id}
      icon={LogIn}
      title={heading}
      description={resolvedDescription}
      note={
        hints.length > 0 ? (
          <ul className="list-disc ml-5 space-y-0.5">
            {hints.map(({ label, value }) => (
              <li key={label}>
                {label}: <code className="font-mono">{value}</code>
              </li>
            ))}
          </ul>
        ) : undefined
      }
    />
  )
}
