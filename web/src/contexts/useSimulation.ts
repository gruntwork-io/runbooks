import { useContext } from "react"
import { SimulationContext } from "./SimulationContext.types"

export function useSimulation() {
  return useContext(SimulationContext)
}
