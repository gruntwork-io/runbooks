import { Effect, Layer } from "effect"
import { Environment } from "../services/Environment.ts"

export const makeTestEnvironment = (
  env: Record<string, string> = {},
  platform: NodeJS.Platform = "linux",
) => {
  const store = { ...env }

  return Layer.succeed(Environment, {
    get: (key) => Effect.succeed(store[key]),
    getAll: () => Effect.succeed({ ...store }),
    platform,
  })
}
