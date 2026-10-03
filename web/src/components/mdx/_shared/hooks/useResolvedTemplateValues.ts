import { useEffect, useMemo, useState } from "react"
import { useApi } from "@/contexts/ApiContext"
import { useAllOutputs } from "@/contexts/useRunbook"
import { flattenBlockOutputs, omitSensitiveTemplateOutputs } from "@/lib/templateUtils"
import type { BoilerplateVariable } from "@/types/boilerplateVariable"
import { containsTemplateValue } from "../lib/templateValue"

interface Resolution {
  /** The input values the request sent. */
  sent: Record<string, unknown>
  /** The same values, with each template resolved where it could be. */
  resolved: Record<string, unknown>
}

/**
 * What each template-valued form value (`{{ .ProjectName }}-state`) comes to
 * right now, by variable name, for display. Main resolves them the way a
 * render does (boilerplate:resolve-inputs), against the form's other values
 * and the block outputs.
 *
 * Only values the form may show are sent: sensitive fields and sensitive
 * outputs are left out, so a value built from one can't resolve and keeps its
 * tokens. A name is left out of the result until its current value has been
 * resolved; a template that didn't resolve stays a template in it.
 */
export function useResolvedTemplateValues(
  values: Record<string, unknown>,
  variables: readonly BoilerplateVariable[],
): Record<string, unknown> {
  const api = useApi()
  const allOutputs = useAllOutputs()

  // The request as JSON, so the effect below sends one only when its content
  // changes, not on every new form-data object.
  const requestKey = useMemo(() => {
    const sensitive = new Set(variables.filter((v) => v.sensitive).map((v) => v.name))
    const inputs = Object.fromEntries(
      Object.entries(values).filter(([name]) => !sensitive.has(name)),
    )
    if (!Object.values(inputs).some(containsTemplateValue)) return null
    const outputs = omitSensitiveTemplateOutputs(flattenBlockOutputs(allOutputs))
    return JSON.stringify({ inputs, outputs })
  }, [values, variables, allOutputs])

  const [resolution, setResolution] = useState<Resolution | null>(null)

  useEffect(() => {
    if (!requestKey || !api) return
    const request = JSON.parse(requestKey) as {
      inputs: Record<string, unknown>
      outputs: Record<string, Record<string, string>>
    }
    let current = true
    api.invoke("boilerplate:resolve-inputs", request).then(
      ({ inputs }) => {
        if (current) setResolution({ sent: request.inputs, resolved: inputs })
      },
      // Main can't resolve right now: the values keep their tokens.
      () => {},
    )
    return () => {
      current = false
    }
  }, [api, requestKey])

  return useMemo(() => {
    const result: Record<string, unknown> = {}
    if (!resolution) return result
    for (const [name, value] of Object.entries(values)) {
      if (!containsTemplateValue(value) || !(name in resolution.resolved)) continue
      // A result for an earlier version of this value would show the wrong thing.
      if (JSON.stringify(resolution.sent[name]) !== JSON.stringify(value)) continue
      result[name] = resolution.resolved[name]
    }
    return result
  }, [resolution, values])
}
