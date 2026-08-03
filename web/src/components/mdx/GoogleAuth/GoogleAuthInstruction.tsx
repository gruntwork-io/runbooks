import { useMemo } from 'react'
import { LogIn } from 'lucide-react'
import { Instruction } from '@/components/mdx/_shared'
import { useTemplateContext } from '@/contexts/useRunbook'
import { resolveTemplateReferences } from '@/lib/templateUtils'
import { DEFAULT_GOOGLE_SCOPES, formatGcloudAdcLoginCommand } from './constants'
import type { GoogleAuthProps } from './types'

/**
 * Instruction-mode rendering of a GoogleAuth block: a plain "Log into Google
 * Cloud" instruction. No service-account key capture, no sign-in flow, no
 * gcloud configuration picker — just what a human needs to do the same thing by
 * hand. The project qualifier comes from the `project` prop when set.
 *
 * This is a separate component (not a branch inside GoogleAuth) so the
 * interactive path's `useGoogleAuth` hook — which kicks off credential
 * detection on mount — is never invoked while the mode is on. Kept consistent
 * with AwsAuthInstruction/GitAuthInstruction per AGENTS.md.
 */
export function GoogleAuthInstruction({
  id,
  description,
  project,
  scopes,
  defaultRegion,
  gcloudConfiguration,
  inputsId,
}: GoogleAuthProps) {
  const templateCtx = useTemplateContext(inputsId)

  const resolvedProject = useMemo(
    () => (project ? resolveTemplateReferences(project, templateCtx) : undefined),
    [project, templateCtx],
  )
  const resolvedDescription = useMemo(
    () => (description ? resolveTemplateReferences(description, templateCtx) : undefined),
    [description, templateCtx],
  )
  const resolvedConfiguration = useMemo(
    () => (gcloudConfiguration ? resolveTemplateReferences(gcloudConfiguration, templateCtx) : undefined),
    [gcloudConfiguration, templateCtx],
  )

  const heading = resolvedProject
    ? `Log into Google Cloud in the \`${resolvedProject}\` project`
    : 'Log into Google Cloud'

  // Surface the configured details so the user can reproduce the login by hand.
  // These are hints, not commands — nothing here authenticates the app.
  const hints: { label: string; value: string }[] = []
  if (resolvedProject) hints.push({ label: 'Project', value: resolvedProject })
  if (defaultRegion) hints.push({ label: 'Region', value: defaultRegion })
  if (resolvedConfiguration) hints.push({ label: 'Config', value: resolvedConfiguration })
  const effectiveScopes = scopes ?? [...DEFAULT_GOOGLE_SCOPES]
  hints.push({ label: 'Scopes', value: effectiveScopes.join(', ') })
  // Only append --scopes when the author set them; defaults are Sign-In request
  // scopes, not a hard ADC requirement in the by-hand recovery path.
  hints.push({
    label: 'Command',
    value: formatGcloudAdcLoginCommand(scopes && scopes.length > 0 ? scopes : []),
  })

  return (
    <Instruction
      id={id}
      icon={LogIn}
      title={heading}
      description={resolvedDescription}
      note={
        <ul className="list-disc ml-5 space-y-0.5">
          {hints.map(({ label, value }) => (
            <li key={label}>
              {label}: <code className="font-mono">{value}</code>
            </li>
          ))}
        </ul>
      }
    />
  )
}
