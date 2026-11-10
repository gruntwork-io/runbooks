/**
 * IPC handlers for the <TofuModule> block: reading the module it presents,
 * and the lookups that fill its dropdowns and suggestions.
 */
import { Effect } from "effect"
import { ipcMain } from "electron"
import { runtime } from "./runtime.ts"
import { validateSessionPath } from "./path-guard.ts"
import { activeSimulationScenario, simulationEnabled } from "./simulation.ts"
import { loadModule } from "../../../src/domain/tofu-module/load.ts"
import { simulatedRows } from "../../../src/domain/tofu-module/simulation.ts"
import { TofuModuleError } from "../../../src/errors/index.ts"
import { isRemoteSource } from "../../../src/remote-source.ts"
import type { TofuModuleLookupRequest, TofuModuleReadRequest } from "../../shared/channels.ts"

/** The most rows a lookup returns; the user narrows the rest by typing. */
const MAX_LOOKUP_ROWS = 50

export function registerTofuModuleHandlers(): void {
  ipcMain.handle("tofu-module:read", async (_event, params: TofuModuleReadRequest) =>
    runtime.runPromise(
      Effect.gen(function* () {
        if (!params?.source) {
          return yield* new TofuModuleError({
            message: "The block needs a source: the module's path or URL.",
          })
        }
        if (isRemoteSource(params.source)) {
          return yield* new TofuModuleError({
            message: "Reading a module from a URL isn't supported yet. Use a path to a local copy.",
          })
        }
        const dir = yield* validateSessionPath(params.source)
        return yield* loadModule(dir)
      }),
    ),
  )

  ipcMain.handle("tofu-module:lookup", async (_event, params: TofuModuleLookupRequest) =>
    runtime.runPromise(
      Effect.gen(function* () {
        if (!simulationEnabled()) {
          return yield* new TofuModuleError({
            message: `The ${params.from} lookup only answers in simulation mode so far. Open the runbook with --simulate to try it with sample data.`,
          })
        }
        const scenario = yield* activeSimulationScenario
        const answer = scenario.lookups[params.from]
        if (answer?.delayMs) yield* Effect.sleep(answer.delayMs)
        const rows = yield* Effect.try({
          try: () => simulatedRows(scenario, params.from, params.query ?? ""),
          catch: (cause) =>
            cause instanceof TofuModuleError
              ? cause
              : new TofuModuleError({ message: String(cause), cause }),
        })
        return { rows: rows.slice(0, MAX_LOOKUP_ROWS) }
      }),
    ),
  )
}
