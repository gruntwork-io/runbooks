import { Context, Effect } from "effect"

export interface TelemetryShape {
  readonly track: (event: string, properties?: Record<string, unknown>) => Effect.Effect<void>
  readonly trackCommand: (command: string) => Effect.Effect<void>
  readonly trackError: (errorType: string) => Effect.Effect<void>
  readonly isEnabled: () => Effect.Effect<boolean>
}

export class Telemetry extends Context.Tag("Telemetry")<Telemetry, TelemetryShape>() {}
