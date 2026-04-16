/**
 * Composed application layer providing all live service implementations.
 */
import { Layer } from "effect"
import { NodeFileSystemLive } from "./NodeFileSystem.ts"
import { ChildProcessSpawnerLive } from "./ChildProcessSpawner.ts"
import { ProcessEnvironmentLive } from "./ProcessEnvironment.ts"
import { AwsSdkClientLive } from "./AwsSdkClient.ts"
import { GitHubHttpClientLive } from "./GitHubHttpClient.ts"
import { WasmBoilerplateLive } from "./WasmBoilerplate.ts"
import { MixpanelTelemetryLive } from "./MixpanelTelemetry.ts"
import { GitCliClientLive } from "./GitCliClient.ts"

/**
 * Base services that have no inter-service dependencies.
 */
const BaseLive = Layer.mergeAll(
  NodeFileSystemLive,
  ChildProcessSpawnerLive,
  ProcessEnvironmentLive,
  AwsSdkClientLive,
  GitHubHttpClientLive,
  MixpanelTelemetryLive,
)

/**
 * Boilerplate renderer requires FileSystem — provide it from NodeFileSystemLive.
 */
const BoilerplateLive = Layer.provide(WasmBoilerplateLive, NodeFileSystemLive)

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
export const AppLive = Layer.mergeAll(BaseLive, GitLive, BoilerplateLive)
