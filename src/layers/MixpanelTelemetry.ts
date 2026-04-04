/**
 * Live implementation of the Telemetry service backed by the telemetry singleton.
 */
import { Layer } from "effect"
import { Telemetry } from "../services/Telemetry.ts"
import { makeTelemetryService } from "../telemetry.ts"

export const MixpanelTelemetryLive = Layer.succeed(Telemetry, makeTelemetryService())
