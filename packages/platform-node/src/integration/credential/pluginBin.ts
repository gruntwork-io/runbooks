/**
 * A temporary bin folder holding one credential plugin, pinned by its
 * SHA-256 as `resources/plugins.lock` pins a released one, and the layers
 * that open it as the app does: `pluginCredentialProviders` through the
 * transport owner, on the real filesystem.
 */
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Layer, Schema } from "effect"
import { pluginCredentialProviders } from "@runbooks/core/credential/plugin"
import type { CredentialProviders } from "@runbooks/core/credential/provider"
import { Platform, type PluginEntry, Sha256 } from "@runbooks/core/plugin/transport"
import type { FileSystem } from "@runbooks/core/services/FileSystem"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"
import { binaryName, nodePluginProcess } from "../../layers/NodePluginProcess.ts"

export const PLATFORM = Schema.decodeUnknownSync(Platform)(
  `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`,
)

const FAKE = path.join(import.meta.dirname, "..", "..", "fixtures", "credentialFake.ts")

const sha256Of = (file: string) =>
  Schema.decodeUnknownSync(Sha256)(createHash("sha256").update(readFileSync(file)).digest("hex"))

/**
 * Writes the fake plugin's binary into `binDir` as plugin `name`: a script
 * that starts `../../fixtures/credentialFake.ts` with this Bun.
 */
export const installFake = (binDir: string, name = "fake"): PluginEntry => {
  const binary = path.join(binDir, binaryName("credential", name, PLATFORM))
  writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${FAKE}"\n`)
  chmodSync(binary, 0o755)
  return { name, kind: "credential", version: "0.0.0", sha256: { [PLATFORM]: sha256Of(binary) } }
}

/**
 * Copies a released binary into `binDir` as plugin `name`, pinned by
 * `sha256`: the owner refuses it when the copy's hash is another.
 */
export const installBinary = (
  binDir: string,
  name: string,
  from: string,
  sha256: string,
): PluginEntry => {
  const binary = path.join(binDir, binaryName("credential", name, PLATFORM))
  copyFileSync(from, binary)
  chmodSync(binary, 0o755)
  return {
    name,
    kind: "credential",
    version: "0.0.0",
    sha256: { [PLATFORM]: Schema.decodeUnknownSync(Sha256)(sha256) },
  }
}

/**
 * The app's credential providers over the plugins in `binDir`, each run
 * from a copy in `runDir`, and the filesystem they check files on.
 */
export const pluginProviders = (
  binDir: string,
  runDir: string,
  plugins: ReadonlyArray<PluginEntry>,
): Layer.Layer<CredentialProviders | FileSystem> =>
  pluginCredentialProviders.pipe(
    Layer.provideMerge(
      nodePluginProcess({ binDir, runDir, platform: PLATFORM, plugins, caller: "runbooks/test" }),
    ),
    Layer.provideMerge(NodeFileSystemLive),
  )
