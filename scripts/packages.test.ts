import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"
import { PACKAGES, packageOf, type PackageName } from "./packages.ts"

const ROOT = path.resolve(import.meta.dir, "..")
const BASE = "tsconfig.packages.json"

interface TsConfig {
  readonly extends?: string
  readonly references?: ReadonlyArray<{ readonly path: string }>
  readonly compilerOptions?: { readonly paths?: Record<string, ReadonlyArray<string>> }
}

const read = async (file: string): Promise<TsConfig> =>
  Bun.JSONC.parse(await Bun.file(path.join(ROOT, file)).text()) as TsConfig

const names = Object.keys(PACKAGES) as PackageName[]
const existing = names.filter((name) =>
  existsSync(path.join(ROOT, PACKAGES[name].dir, "tsconfig.json")),
)

describe("the packages", () => {
  it("are the projects that extend tsconfig.packages.json", async () => {
    const glob = new Bun.Glob("{blocks,packages}/**/tsconfig.json")
    const found: string[] = []
    for await (const file of glob.scan({ cwd: ROOT })) {
      if (file.includes("node_modules")) continue
      const config = await read(file)
      if (
        config.extends &&
        path.resolve(ROOT, path.dirname(file), config.extends) === path.join(ROOT, BASE)
      ) {
        found.push(path.dirname(file))
      }
    }
    expect(found.sort((a, b) => a.localeCompare(b))).toEqual(
      existing.map((name) => PACKAGES[name].dir).sort((a, b) => a.localeCompare(b)),
    )
    expect(existing).toEqual(expect.arrayContaining(["blocks-core", "core", "cli"]))
  })

  it.each(existing)("%s references only packages it may import", async (name) => {
    const dir = PACKAGES[name].dir
    const { references = [] } = await read(path.join(dir, "tsconfig.json"))
    const referenced = references.map((ref) =>
      packageOf(`${path.join(dir, ref.path)}/tsconfig.json`),
    )
    expect(
      referenced.filter((ref) => ref === undefined || !PACKAGES[name].mayImport.includes(ref)),
    ).toEqual([])
  })

  it("export only their own files", async () => {
    const { compilerOptions } = await read(BASE)
    const misplaced = Object.entries(compilerOptions?.paths ?? {}).flatMap(([key, targets]) => {
      const owner = /^@runbooks\/([a-z-]+)(?:\/|$)/.exec(key)?.[1]
      return targets
        .filter((target) => owner === undefined || packageOf(path.normalize(target)) !== owner)
        .map((target) => `${key} -> ${target}`)
    })
    expect(misplaced).toEqual([])
  })
})

describe("packageOf", () => {
  it("names the deepest package holding a file", () => {
    expect(packageOf("blocks/core/contract.ts")).toBe("blocks-core")
    expect(packageOf("blocks/aws-auth/block.ts")).toBe("blocks")
    expect(packageOf("packages/core/src/engine/protocol.ts")).toBe("core")
    expect(packageOf("packages/corex/a.ts")).toBeUndefined()
    expect(packageOf("src/logger.ts")).toBeUndefined()
  })
})
