import { createContext } from "react"
import type { SimulationState } from "../../../electron/shared/channels"

export interface SimulationContextValue {
  state: SimulationState
  /** Picks the scenario lookups answer from. */
  setScenario: (name: string) => void
  /** Changes whenever the answers may have changed, so blocks fetch their lookups again. */
  revision: number
}

/** Without a provider, simulation is off. */
export const SimulationContext = createContext<SimulationContextValue>({
  state: { enabled: false },
  setScenario: () => {},
  revision: 0,
})
