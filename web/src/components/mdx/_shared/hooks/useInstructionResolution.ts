import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useApi } from '@/contexts/ApiContext'
import { buildTemplatePayload, type TemplateContext } from '@/lib/templateUtils'
import {
  detectManualFields,
  fieldsNeedingPrompt,
  buildMergedContext,
  resolveCommandClientSide,
  normalizeCommandList,
  type ManualFieldSpec,
} from '../lib/instructionResolution'

/** A manual field ready to render: spec plus its current value and a setter. */
export interface ManualField extends ManualFieldSpec {
  value: string
  onChange: (value: string) => void
}

export interface UseInstructionResolutionResult {
  /** The resolved command(s), in input order, never containing a raw `{{ … }}`. */
  resolvedCommands: string[]
  /** Auto-detected prompts for `{{ .outputs.* }}` values the user must supply. */
  manualFields: ManualField[]
  /** True while the full engine render is in flight. */
  isResolving: boolean
  /** True when the lower-fidelity client-side resolver was used (engine errored). */
  usedFallback: boolean
}

interface UseInstructionResolutionOptions {
  /** Raw command text (with `{{ … }}` references intact). */
  command: string | string[] | undefined
  /** Template context from the Inputs forms (inputs + any context outputs). */
  templateContext: TemplateContext
}

/**
 * Resolve a runbook command into a flattened instruction for instruction mode
 * (spec §5/§6.5): auto-detect `{{ .outputs.* }}` references as manual fields,
 * merge the user's entries with the Inputs-form values, and resolve the whole
 * command via the side-effect-free full engine (`boilerplate:render-inline`),
 * falling back to the client-side resolver if the engine errors or is
 * unavailable. Never returns a command containing a raw `{{ … }}`.
 *
 * Inputs (`command`, `templateContext`) are commonly fresh object references on
 * every render, so every derived value is keyed on a serialized string rather
 * than object identity — otherwise the resolution effect would re-fire forever.
 */
export function useInstructionResolution({
  command,
  templateContext,
}: UseInstructionResolutionOptions): UseInstructionResolutionResult {
  const api = useApi()

  // Stable value-based keys for the two reference-typed inputs.
  const commandKey = useMemo(
    () => JSON.stringify(normalizeCommandList(command)),
    [command],
  )
  const contextKey = useMemo(
    () => JSON.stringify(templateContext),
    [templateContext],
  )

  const commands = useMemo<string[]>(() => JSON.parse(commandKey), [commandKey])

  // All auto-detected output references (§6.5.5). Stable across keystrokes.
  const allFieldSpecs = useMemo(() => detectManualFields(commands), [commands])

  // Only prompt for references the context can't already resolve (e.g. a
  // DirPicker's published path resolves without a prompt).
  const fieldSpecs = useMemo(
    () =>
      fieldsNeedingPrompt(allFieldSpecs, JSON.parse(contextKey) as TemplateContext),
    [allFieldSpecs, contextKey],
  )

  // The user's manually-entered output values, keyed by field id (template path).
  const [manualValues, setManualValues] = useState<Record<string, string>>({})

  const setFieldValue = useCallback((id: string, value: string) => {
    setManualValues((prev) => ({ ...prev, [id]: value }))
  }, [])

  const mergedContext = useMemo(
    () =>
      buildMergedContext(
        JSON.parse(contextKey) as TemplateContext,
        fieldSpecs,
        manualValues,
      ),
    [contextKey, fieldSpecs, manualValues],
  )

  // Client-side resolution is synchronous and always available — use it as the
  // initial value so the command renders immediately, then upgrade to the
  // full-engine result when it arrives.
  const clientResolved = useMemo(
    () => commands.map((c) => resolveCommandClientSide(c, mergedContext)),
    [commands, mergedContext],
  )

  const [resolvedCommands, setResolvedCommands] = useState<string[]>(clientResolved)
  const [isResolving, setIsResolving] = useState(false)
  const [usedFallback, setUsedFallback] = useState(false)

  const isMountedRef = useRef(true)
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    // No template references → the command is already literal; nothing to render
    // and no IPC needed. Also covers the no-command case.
    const hasTemplates = commands.some((c) => c.includes('{{'))
    if (!hasTemplates) {
      setResolvedCommands(commands)
      setUsedFallback(false)
      setIsResolving(false)
      return
    }

    // No IPC bridge (e.g. component tests without an ApiProvider) → client-side.
    if (!api?.invoke) {
      setResolvedCommands(clientResolved)
      setUsedFallback(true)
      setIsResolving(false)
      return
    }

    let cancelled = false
    setIsResolving(true)

    const templateFiles: Record<string, string> = {}
    commands.forEach((c, i) => {
      templateFiles[`cmd-${i}`] = c
    })
    const inputs = buildTemplatePayload(mergedContext)

    api
      .invoke('boilerplate:render-inline', { templateFiles, inputs })
      .then((response: { renderedFiles?: Record<string, { content: string }> }) => {
        if (cancelled || !isMountedRef.current) return
        const rendered = response?.renderedFiles
        const out = commands.map((c, i) => rendered?.[`cmd-${i}`]?.content ?? c)
        // Defend the hard rule: if the engine left any raw template behind,
        // fall back to the client-side resolver for those entries.
        const safe = out.map((text, i) =>
          text.includes('{{') ? clientResolved[i] : text,
        )
        setResolvedCommands(safe)
        setUsedFallback(false)
        setIsResolving(false)
      })
      .catch(() => {
        if (cancelled || !isMountedRef.current) return
        setResolvedCommands(clientResolved)
        setUsedFallback(true)
        setIsResolving(false)
      })

    return () => {
      cancelled = true
    }
  }, [api, commands, mergedContext, clientResolved])

  const manualFields = useMemo<ManualField[]>(
    () =>
      fieldSpecs.map((spec) => ({
        ...spec,
        value: manualValues[spec.id] ?? '',
        onChange: (value: string) => setFieldValue(spec.id, value),
      })),
    [fieldSpecs, manualValues, setFieldValue],
  )

  return { resolvedCommands, manualFields, isResolving, usedFallback }
}
