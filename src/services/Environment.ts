import { Context, Effect } from "effect"

export interface EnvironmentShape {
  readonly get: (key: string) => Effect.Effect<string | undefined>
  readonly getAll: () => Effect.Effect<Record<string, string>>
  readonly set: (key: string, value: string) => Effect.Effect<void>
  readonly delete: (key: string) => Effect.Effect<void>
  readonly snapshot: () => Effect.Effect<Record<string, string>>
}

export class Environment extends Context.Tag("Environment")<Environment, EnvironmentShape>() {}
