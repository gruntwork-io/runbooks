/**
 * Composed application layer providing all live service implementations.
 */
import { Layer } from "effect"
import { NodeFileSystemLive } from "./NodeFileSystem.ts"
import { ChildProcessSpawnerLive } from "./ChildProcessSpawner.ts"
import { ProcessEnvironmentLive } from "./ProcessEnvironment.ts"
import { AwsSdkClientLive } from "./AwsSdkClient.ts"
import { GitHubHttpClientLive } from "./GitHubHttpClient.ts"
import { GitLabHttpClientLive } from "./GitLabHttpClient.ts"
import { WasmBoilerplateLive } from "./WasmBoilerplate.ts"
import { NodeWasmRuntimeLive } from "./NodeWasmRuntime.ts"
import { NodeBundleProducerLive } from "./NodeBundleProducer.ts"
import { NodeWarmRenderDispatcherLive } from "./NodeWarmRenderDispatcher.ts"
import { MixpanelTelemetryLive } from "./MixpanelTelemetry.ts"
import { GitCliClientLive } from "./GitCliClient.ts"
import { VcsCredentialsLive } from "./VcsCredentialsLive.ts"

/**
 * The unified VCS credential resolver needs the
 * spawn/env/fs primitives for source reads plus both HTTP clients for direct
 * validation.
 */
const VcsCredentialsWithDeps = Layer.provide(
  VcsCredentialsLive,
  Layer.mergeAll(
    NodeFileSystemLive,
    ChildProcessSpawnerLive,
    ProcessEnvironmentLive,
    GitHubHttpClientLive,
    GitLabHttpClientLive,
  ),
)

/**
 * Base services that have no inter-service dependencies.
 */
const BaseLive = Layer.mergeAll(
  NodeFileSystemLive,
  ChildProcessSpawnerLive,
  ProcessEnvironmentLive,
  AwsSdkClientLive,
  GitHubHttpClientLive,
  GitLabHttpClientLive,
  MixpanelTelemetryLive,
  VcsCredentialsWithDeps,
)

/**
 * Boilerplate renderer requires FileSystem (for var-file + output dir work),
 * ProcessSpawner (for shelling out to the boilerplate CLI in renderTemplate),
 * and WasmRuntime (for the in-process renderFile path used by TemplateInline).
 */
const BoilerplateLive = Layer.provide(
  WasmBoilerplateLive,
  Layer.mergeAll(NodeFileSystemLive, ChildProcessSpawnerLive, NodeWasmRuntimeLive),
)

/**
 * Bundle producer shells out to the same boilerplate binary (just with the
 * `inputs map --include-bundle` subcommand) so it only needs ProcessSpawner.
 */
const BundleProducerLive = Layer.provide(NodeBundleProducerLive, ChildProcessSpawnerLive)

/**
 * Warm dispatcher needs BundleProducer (for bundle JSON) and WasmRuntime (to
 * actually call the WASM exports).
 */
const WarmRenderLive = Layer.provide(
  NodeWarmRenderDispatcherLive,
  Layer.mergeAll(BundleProducerLive, NodeWasmRuntimeLive),
)

/**
 * Git layer requires ProcessSpawner — provide it explicitly from BaseLive.
 */
const GitLive = Layer.provide(GitCliClientLive, ChildProcessSpawnerLive)

/**
 * Full application layer with all services wired together.
 *
 * Usage:
 *   Effect.runPromise(myProgram.pipe(Effect.provide(AppLive)))
 */
export const AppLive = Layer.mergeAll(
  BaseLive,
  GitLive,
  BoilerplateLive,
  BundleProducerLive,
  NodeWasmRuntimeLive,
  WarmRenderLive,
)
