/**
 * IPC handler for the <TfModule> block: reading the module it presents.
 */
import { Effect } from "effect"
import { ipcMain } from "electron"
import { runtime } from "./runtime.ts"
import { moduleDir } from "./tf-module-source.ts"
import { loadModule } from "../../../src/domain/tf-module/load.ts"
import { modulePage } from "../../../src/domain/tf-module/modulePage.ts"
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
        const dir = yield* moduleDir(params.source)
        const spec = yield* loadModule(dir)
        const page = yield* modulePage(params.source, dir)
        const warning = unpinnedSourceWarning(params.source)
        return {
          ...spec,
          ...(page ? { page } : {}),
          ...(warning ? { warnings: [...spec.warnings, warning] } : {}),
        }
      }),
    ),
  )
}
