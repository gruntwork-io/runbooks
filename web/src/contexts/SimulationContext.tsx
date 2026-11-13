import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { useApi } from "./ApiContext"
import { SimulationContext } from "./SimulationContext.types"
import type { SimulationState } from "../../../electron/shared/channels"

/**
 * Whether the app answers from the runbook's simulation.yml, and which of its
 * scenarios is active. `runbookKey` changes when another runbook opens, whose
 * simulation.yml is a different file.
 */
export function SimulationProvider({
  runbookKey,
  children,
}: {
  runbookKey: string | undefined
  children: ReactNode
}) {
  const api = useApi()
  const [state, setState] = useState<SimulationState>({ enabled: false })
  const [revision, setRevision] = useState(0)

  const refresh = useCallback(() => {
    api
      .invoke("simulation:state")
      .then((next) => {
        setState(next)
        setRevision((r) => r + 1)
      })
      .catch(() => setState({ enabled: false }))
  }, [api])

  useEffect(() => {
    refresh()
  }, [refresh, runbookKey])

  const setScenario = useCallback(
    (name: string) => {
      void api.invoke("simulation:set-scenario", { name }).then(refresh)
    },
    [api, refresh],
  )

  const value = useMemo(() => ({ state, setScenario, revision }), [state, setScenario, revision])
  return <SimulationContext.Provider value={value}>{children}</SimulationContext.Provider>
}
