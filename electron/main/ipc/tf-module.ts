/**
 * IPC handler for the <TfModule> block: reading the module it presents.
 */
import { Effect } from "effect"
import { ipcMain } from "electron"
import { runtime } from "./runtime.ts"
import { moduleDir } from "./tf-module-source.ts"
import { loadModule } from "../../../src/domain/tf-module/load.ts"
import { TfModuleError } from "../../../src/errors/index.ts"
import { unpinnedSourceWarning } from "../../../src/domain/tf-module/moduleSource.ts"
import type { TfModuleReadRequest } from "../../shared/channels.ts"

export function registerTfModuleHandlers(): void {
  ipcMain.handle("tf-module:read", async (_event, params: TfModuleReadRequest) =>
    runtime.runPromise(
      Effect.gen(function* () {
        if (!params?.source) {
          return yield* new TfModuleError({
            message: "The block needs a source: the module's path or URL.",
          })
        }
        const spec = yield* loadModule(yield* moduleDir(params.source))
        const warning = unpinnedSourceWarning(params.source)
        return warning ? { ...spec, warnings: [...spec.warnings, warning] } : spec
      }),
    ),
  )
}
