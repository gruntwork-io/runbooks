/**
 * The engine protocol's handlers: each command served by the `Engine`, and
 * the settings commands by the `SettingsStore`. Every transport serves this
 * one layer: the in-process transport here, and IPC and MCP (phase 3). A
 * transport adds only `CallerMiddleware`, which says who is calling.
 */
import { Effect, Layer } from "effect"
import type { Rpc } from "effect/rpc"
import type { Registry } from "@runbooks/blocks-core/registry"
import { Engine, type EngineOptions } from "./engine.ts"
import { type EngineCommand, EngineProtocol } from "./protocol.ts"
import { SettingsStore } from "./settings.ts"

export const EngineHandlers: Layer.Layer<
  Rpc.ToHandler<EngineCommand>,
  never,
  Engine | SettingsStore
> = EngineProtocol.toLayer(
  Effect.gen(function* () {
    const engine = yield* Engine
    const settings = yield* SettingsStore
    return EngineProtocol.of({
      OpenSession: engine.openSession,
      CloseSession: engine.closeSession,
      ListSessions: () => engine.listSessions,
      GetSession: engine.getSession,
      GetDocument: engine.getDocument,
      TrustSession: engine.trustSession,
      Events: engine.events,
      GetBlock: engine.getBlock,
      SetValues: engine.setValues,
      ConfirmValues: engine.confirmValues,
      RunBlock: engine.runBlock,
      CancelBlock: engine.cancelBlock,
      ResetBlock: engine.resetBlock,
      WaitForBlock: engine.waitForBlock,
      GetOutputs: engine.getOutputs,
      ActOnCredential: engine.actOnCredential,
      ResolveApproval: engine.resolveApproval,
      GetSettings: () => settings.get,
      ChangeSettings: ({ changes }) => settings.change(changes),
      WatchSettings: () => settings.watch,
    })
  }),
)

/**
 * `EngineHandlers` over an engine of their own, made from `options`: what an
 * entry point serves. The `Engine` stays inside the layer, so a client
 * drives it only through the protocol.
 */
export const serveEngine = <R extends Registry>(options: EngineOptions<R>) =>
  EngineHandlers.pipe(Layer.provide(Engine.layer(options)))
