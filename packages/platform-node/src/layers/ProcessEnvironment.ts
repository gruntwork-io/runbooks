/**
 * Live implementation of the Environment service using process.env.
 */
import { Effect, Layer } from "effect"
import { Environment } from "@runbooks/core/services/Environment"
import type { EnvironmentShape } from "@runbooks/core/services/Environment"

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

  platform: process.platform,
}

export const ProcessEnvironmentLive = Layer.succeed(Environment, impl)
