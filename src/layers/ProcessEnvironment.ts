/**
 * Live implementation of the Environment service using process.env.
 */
import { Effect, Layer } from "effect"
import { Environment } from "../services/Environment.ts"
import type { EnvironmentShape } from "../services/Environment.ts"

function filterStringValues(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      result[key] = value
    }
  }
  return result
}

const impl: EnvironmentShape = {
  get: (key: string) => Effect.sync(() => process.env[key]),

  getAll: () => Effect.sync(() => filterStringValues(process.env)),

  set: (key: string, value: string) =>
    Effect.sync(() => {
      process.env[key] = value
    }),

  delete: (key: string) =>
    Effect.sync(() => {
      delete process.env[key]
    }),
}

export const ProcessEnvironmentLive = Layer.succeed(Environment, impl)
