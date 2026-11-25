/**
 * An in-memory `CredentialProviders` for the engine's tests. Each provider
 * name maps to a script, and each block that opens one gets an instance of
 * its own, made from the config it was opened with. Every call is noted,
 * with the block that made it, in one list, so a test asserts on all the
 * engine asked of its providers.
 *
 * It is not the shared fake provider (2.13): no contract suite holds it to
 * what a real provider does, so it answers only what a test scripts.
 */
import path from "node:path"
import { Effect, Layer, Option, Stream } from "effect"
import { CredentialError } from "@runbooks/blocks-core/contract"
import {
  type CredentialProvider,
  CredentialProviders,
  type ProviderConfig,
  type ProviderInfo,
} from "../credential/provider.ts"

export interface ProviderCall {
  /** The block that made it: the last part of the state directory it was opened with. */
  readonly block: string
  readonly method: "open" | keyof CredentialProvider
  readonly args: ReadonlyArray<unknown>
}

/** What one block's provider answers. A call a test reaches and did not script dies. */
export interface ScriptedProvider extends Partial<Omit<CredentialProvider, "describe">> {
  readonly info: ProviderInfo
}

const unscripted = (method: string) => Effect.die(new Error(`${method} was not scripted`))

/** The provider `script` describes, noting each call it gets in `calls`. */
function recording(
  block: string,
  script: ScriptedProvider,
  calls: ProviderCall[],
): CredentialProvider {
  const note = (method: ProviderCall["method"], args: ReadonlyArray<unknown>) =>
    calls.push({ block, method, args })
  return {
    describe: Effect.suspend(() => {
      note("describe", [])
      return Effect.succeed(script.info)
    }),
    detect: (sources, constraints) =>
      Effect.suspend(() => {
        note("detect", [sources, constraints])
        return script.detect?.(sources, constraints) ?? Effect.succeed(Option.none())
      }),
    signIn: (method, fields, constraints) =>
      Stream.suspend(() => {
        note("signIn", [method, fields, constraints])
        return (
          script.signIn?.(method, fields, constraints) ?? Stream.fromEffect(unscripted("signIn"))
        )
      }),
    targets: (level, parent) =>
      Effect.suspend(() => {
        note("targets", [level, parent])
        return script.targets?.(level, parent) ?? unscripted("targets")
      }),
    select: (targets) =>
      Effect.suspend(() => {
        note("select", [targets])
        return script.select?.(targets) ?? unscripted("select")
      }),
    env: Effect.suspend(() => {
      note("env", [])
      return script.env ?? unscripted("env")
    }),
    signOut: Effect.suspend(() => {
      note("signOut", [])
      return script.signOut ?? Effect.void
    }),
  }
}

/**
 * Opens a provider by name from `scripts`, each block's from its own call
 * to the script, noting every call in `calls`. A name with no script fails
 * with `providerFailed`, as a missing binary does.
 */
export const testCredentialProviders = (
  scripts: Readonly<Record<string, (config: ProviderConfig) => ScriptedProvider>>,
  calls: ProviderCall[],
): Layer.Layer<CredentialProviders> =>
  Layer.succeed(CredentialProviders, {
    open: (name, config) =>
      Effect.suspend(() => {
        const block = path.basename(config.stateDir)
        calls.push({ block, method: "open", args: [name, config] })
        const script = Object.hasOwn(scripts, name) ? scripts[name] : undefined
        return script === undefined
          ? Effect.fail(
              new CredentialError({
                kind: "providerFailed",
                message: `There is no credential provider named ${name}.`,
              }),
            )
          : Effect.succeed(recording(block, script(config), calls))
      }),
  })
