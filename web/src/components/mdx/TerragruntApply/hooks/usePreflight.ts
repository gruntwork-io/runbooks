import { useState } from "react"
import { useApi } from "@/contexts/ApiContext"
import { cleanIpcErrorMessage } from "@/lib/ipcError"
import type { TerragruntApplyRequest } from "../../../../../../electron/shared/channels"
import type { BoundBlock } from "../../../../../../src/domain/lookups/validate"
import { lookupEngine, useEngineDeps } from "../../_shared/hooks/useLookupEngine"
import { bindByKind, verdictOf, type PreflightState } from "../preflight"

/**
 * The block's preflight: the main process checks the tools, the push and the
 * unit's module, then the module's checks run here, through the auth blocks
 * `auth` lists, matched by kind.
 */
export function usePreflight(request: TerragruntApplyRequest, auth: readonly BoundBlock[]) {
  const api = useApi()
  const deps = useEngineDeps()
  const [state, setState] = useState<PreflightState>({ kind: "idle" })

  /** Runs the preflight, and says what its findings mean for the plan. */
  const run = async () => {
    setState({ kind: "running" })
    let found: PreflightState
    try {
      const result = await api.invoke("terragrunt-apply:preflight", request)
      if (result.kind !== "ready") found = result
      else {
        const module = result.module
        const { binding, problems } = module
          ? bindByKind(module.definitions, module.preflight, auth)
          : { binding: {}, problems: [] }
        const engine = module
          ? lookupEngine(deps, module.definitions, binding, result.inputs, "to run the checks")
          : undefined
        const results =
          engine && problems.length === 0
            ? await Promise.all(
                (module?.preflight ?? []).map(async (use) => ({
                  use,
                  outcome: await engine.check(use),
                })),
              )
            : []
        found = { ...result, problems, results }
      }
    } catch (err) {
      found = {
        kind: "error",
        error: cleanIpcErrorMessage(err instanceof Error ? err.message : String(err)),
      }
    }
    setState(found)
    return verdictOf(found)
  }

  return { state, run }
}
