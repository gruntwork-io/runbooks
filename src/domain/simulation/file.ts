/** What every part of simulation.yml's reading shares: its name, and how it says what's wrong. */
import { SimulationError } from "../../errors/index.ts"

/** The name of the answers file beside a runbook. */
export const SIMULATION_FILE = "simulation.yml"

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A problem with simulation.yml, naming the file. */
export const simulationError = (message: string) =>
  new SimulationError({ message: `${SIMULATION_FILE}: ${message}` })
