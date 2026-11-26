import { Context, Effect } from "effect"

export interface EnvironmentShape {
  readonly get: (key: string) => Effect.Effect<string | undefined>
  readonly getAll: () => Effect.Effect<Record<string, string>>
  /** The OS the app runs on, as Node names it: where tools such as glab keep their config. */
  readonly platform: NodeJS.Platform
}

export class Environment extends Context.Service<Environment, EnvironmentShape>()("Environment") {}
