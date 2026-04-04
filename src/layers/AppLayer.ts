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
  WasmBoilerplateLive,
  MixpanelTelemetryLive,
)

/**
 * Git layer requires ProcessSpawner from BaseLive.
 */
const GitLive = GitCliClientLive

/**
 * Full application layer with all services wired together.
 *
 * Usage:
 *   Effect.runPromise(myProgram.pipe(Effect.provide(AppLive)))
 */
export const AppLive = BaseLive.pipe(Layer.provideMerge(GitLive))
