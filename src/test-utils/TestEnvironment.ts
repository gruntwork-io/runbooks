import { Effect, Layer } from "effect"
import { Environment } from "../services/Environment.ts"

export const makeTestEnvironment = (env: Record<string, string> = {}) => {
  const store = { ...env }

  return Layer.succeed(Environment, {
    get: (key) => Effect.succeed(store[key]),
    getAll: () => Effect.succeed({ ...store }),
    set: (key, value) =>
      Effect.sync(() => {
        store[key] = value
      }),
    delete: (key) =>
      Effect.sync(() => {
        delete store[key]
      }),
    snapshot: () => Effect.succeed({ ...store }),
  })
}
