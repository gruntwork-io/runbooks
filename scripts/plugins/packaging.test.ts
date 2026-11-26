import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Platform, PluginKind } from "@runbooks/core/plugin/transport"
import { binaryName } from "@runbooks/platform-node/layers/NodePluginProcess"

/** The parts of electron-builder's config, in package.json, that bundle the plugins. */
const Config = Schema.Struct({
  build: Schema.Struct({
    extraResources: Schema.Array(Schema.Struct({ from: Schema.String, to: Schema.String })),
    mac: Schema.Struct({ signIgnore: Schema.Array(Schema.String) }),
  }),
})
const { build } = Schema.decodeUnknownSync(Config)(
  JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8")),
)

/** @electron/osx-sign tests each pattern against a file's absolute path in the built app. */
const APP = "/Users/runner/work/runbooks/runbooks/out/mac-arm64/Runbooks.app"
const signIgnored = (file: string) =>
  build.mac.signIgnore.some((pattern) => new RegExp(pattern).test(`${APP}/${file}`))

describe("packaging the plugins", () => {
  it("ships resources/bin as bin, and the lock beside it as plugins.lock", () => {
    const shipped = build.extraResources.map(({ from, to }) => `${from} -> ${to}`)
    expect(shipped).toContain("resources/bin -> bin")
    expect(shipped).toContain("resources/plugins.lock -> plugins.lock")
  })

  it("leaves every macOS plugin binary as its release signed it", () => {
    const macOS = Platform.literals.filter((platform) => platform.startsWith("darwin-"))
    for (const kind of PluginKind.literals) {
      for (const platform of macOS) {
        expect(signIgnored(`Contents/Resources/bin/${binaryName(kind, "aws", platform)}`)).toBe(
          true,
        )
      }
    }
  })

  it("signs every other file electron-builder signs", () => {
    for (const file of [
      "Contents/MacOS/Runbooks",
      "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
      "Contents/Resources/bin/runbooks-test",
      "Contents/Resources/bin/boilerplate",
      "Contents/Resources/wasm/runbooks-credential-aws",
    ]) {
      expect(signIgnored(file)).toBe(false)
    }
  })
})
