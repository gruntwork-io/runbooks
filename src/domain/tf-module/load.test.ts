import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Effect, Exit, Cause } from "effect"
import * as nodeFs from "node:fs"
import * as nodePath from "node:path"
import * as os from "node:os"
import { NodeFileSystemLive } from "../../layers/NodeFileSystem.ts"
import { configFileNames, loadModule } from "./load.ts"
import type { TfModuleSpec } from "./types.ts"

const FIXTURES = nodePath.resolve(import.meta.dir, "../../../testdata/test-fixtures/tf-modules")
// The preview runbook's copy of fabricahq/infra-catalog's google-group module.
const GOOGLE_GROUP = nodePath.resolve(
  import.meta.dir,
  "../../../testdata/feature-demos/tf-module/google-group",
)

const load = (dir: string) =>
  Effect.runPromiseExit(loadModule(dir).pipe(Effect.provide(NodeFileSystemLive)))

async function loaded(dir: string): Promise<TfModuleSpec> {
  const exit = await load(dir)
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  return exit.value
}

async function failure(dir: string): Promise<string> {
  const exit = await load(dir)
  if (Exit.isSuccess(exit)) throw new Error("expected the module not to load")
  return Cause.squash(exit.cause) instanceof Error
    ? (Cause.squash(exit.cause) as Error).message
    : ""
}

const byName = (spec: TfModuleSpec, name: string) => {
  const variable = spec.variables.find((v) => v.name === name)
  if (!variable) throw new Error(`no variable ${name}`)
  return variable
}

describe("configFileNames", () => {
  it("reads a .tofu file in place of its .tf twin, as OpenTofu does", () => {
    expect(configFileNames(["versions.tf", "versions.tofu", "main.tf", "README.md"])).toEqual([
      "main.tf",
      "versions.tofu",
    ])
  })
})

describe("loadModule", () => {
  it("reads the google-group module with its runbook_block.yml", async () => {
    const spec = await loaded(GOOGLE_GROUP)
    expect(spec.title).toBe("Create a Google Group")
    expect(spec.googleApis).toEqual([
      "cloudidentity.googleapis.com",
      "cloudresourcemanager.googleapis.com",
    ])
    expect(spec.source).toBe(
      "git::https://github.com/fabricahq/infra-catalog.git//modules/google-group?ref=v0.14.0",
    )
    expect(spec.providers).toEqual([
      { name: "google", source: "hashicorp/google", version: ">= 8.10.0, < 9.0.0" },
    ])
    // runbook_block.yml's order, then declaration order, not the alphabetical order the parser returns.
    expect(spec.variables.map((v) => v.name)).toEqual([
      "domain",
      "id",
      "display_name",
      "description",
      "owners",
      "members",
      "customer_id",
      "managers",
      "types",
    ])
    expect(spec.outputs.map((o) => o.name)).toEqual([
      "email",
      "resource_name",
      "customer_id",
      "runbooks_console_url",
    ])
    expect(spec.outputs.find((o) => o.name === "runbooks_console_url")).toMatchObject({
      label: "Admin console",
      link: "View the Google Group",
    })

    const id = byName(spec, "id")
    expect(id).toMatchObject({
      label: "Group email",
      suffix: "@{{ .domain }}",
      primary: true,
      hasDefault: false,
      kind: "string",
    })
    expect(id.checks).toEqual([
      {
        kind: "regex",
        pattern: String.raw`^[^@\s]+@[^@\s]+\.[^@\s]+$`,
        message: "Give the group's email address, such as aws-prod-root@example.com.",
      },
    ])

    expect(byName(spec, "owners")).toMatchObject({
      kind: "list",
      primary: true,
      default: [],
      lookup: { from: "google.people" },
      shortcut: { from: "google.me", value: "email" },
    })
    expect(byName(spec, "managers").primary).toBe(false)

    const types = byName(spec, "types")
    expect(types.kind).toBe("list")
    expect(types.options?.map((o) => o.value)).toEqual([
      "default",
      "security",
      "dynamic",
      "external",
    ])
    expect(spec.warnings).toEqual([])
  })

  it("reads presets, the logo, and the validations a form can check", async () => {
    const spec = await loaded(nodePath.join(FIXTURES, "with-presets"))
    // versions.tofu wins over versions.tf.
    expect(spec.providers.map((p) => p.name)).toEqual(["google"])
    expect(spec.logo).toStartWith("data:image/svg+xml;base64,")
    expect(spec.title).toBe("With presets")

    expect(byName(spec, "access").presets).toEqual([
      {
        name: "public",
        label: "Public",
        description: "Anyone can read it.",
        settings: { read: "ANYONE", write: "MEMBERS" },
      },
      { name: "private", label: "Private", settings: { read: "MEMBERS", write: "OWNERS" } },
    ])

    expect(byName(spec, "name").checks).toEqual([
      { kind: "length", min: 3, max: 20, message: "Use 3 to 20 characters." },
      {
        kind: "regex",
        pattern: String.raw`^[a-z][a-z0-9-]*\d$`,
        message: "Start with a letter and end with a digit.",
      },
    ])
    const owner = byName(spec, "owner")
    expect(owner.checks).toEqual([{ kind: "notEmpty", message: "Name an owner." }])
    expect(owner.constraints).toEqual(["Use an example.com address."])

    expect(byName(spec, "tier").options).toEqual([
      { value: "basic", label: "Basic" },
      { value: "standard", label: "Standard", description: "What most teams use." },
      { value: "premium", label: "Premium" },
    ])
    expect(byName(spec, "config")).toMatchObject({
      kind: "json",
      sensitive: true,
      hasDefault: true,
      default: null,
    })
  })

  it("shows required inputs first when runbook_block.yml picks no primary inputs", async () => {
    const spec = await loaded(nodePath.join(FIXTURES, "s3-bucket"))
    expect(spec.variables.filter((v) => v.primary).map((v) => v.name)).toEqual(["bucket_name"])
    expect(byName(spec, "expiration_days")).toMatchObject({
      kind: "number",
      default: 0,
      label: "Expiration days",
    })
    expect(byName(spec, "tags")).toMatchObject({ kind: "map", default: {} })
  })

  it("reads each of the earlier block's fixture modules", async () => {
    for (const name of ["lambda-function", "lambda-s3-complex", "s3-bucket"]) {
      const spec = await loaded(nodePath.join(FIXTURES, name))
      expect(spec.variables.length).toBeGreaterThan(0)
    }
  })

  describe("refuses a module", () => {
    let dir: string
    beforeEach(() => {
      dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "tf-module-"))
      nodeFs.writeFileSync(
        nodePath.join(dir, "variables.tf"),
        'variable "name" {\n  type = string\n}\n',
      )
    })
    afterEach(() => nodeFs.rmSync(dir, { recursive: true, force: true }))

    const write = (name: string, content: string) =>
      nodeFs.writeFileSync(nodePath.join(dir, name), content)

    it("whose runbook_block.yml describes an input variables.tf doesn't declare", async () => {
      write("runbook_block.yml", "variables:\n  nmae:\n    primary: true\n")
      expect(await failure(dir)).toContain(`describes "nmae", which variables.tf doesn't declare`)
    })

    it("whose suffix reads an input variables.tf doesn't declare", async () => {
      write("runbook_block.yml", 'variables:\n  name:\n    suffix: "@{{ .domain }}"\n')
      expect(await failure(dir)).toContain(`suffix reads "domain"`)
    })

    it("whose runbook_block.yml describes an output the module doesn't declare", async () => {
      write("runbook_block.yml", "outputs:\n  url:\n    link: Open it\n")
      expect(await failure(dir)).toContain(`the outputs "url", which the module doesn't declare`)
    })

    it("whose pull request title reads an input variables.tf doesn't declare", async () => {
      write("runbook_block.yml", 'pullRequest:\n  title: "Add {{ .nmae }}"\n')
      expect(await failure(dir)).toContain(`pullRequest.title reads "nmae"`)
    })

    it("whose pull request summary reads an input variables.tf doesn't declare", async () => {
      write("runbook_block.yml", 'pullRequest:\n  summary: "Creates {{ .nmae }}."\n')
      expect(await failure(dir)).toContain(`pullRequest.summary reads "nmae"`)
    })

    it("whose source isn't a URL", async () => {
      write("runbook_block.yml", "source: ../modules/group\n")
      expect(await failure(dir)).toContain("source must be a URL")
    })

    it("whose runbook_block.yml names a file outside the module", async () => {
      write("runbook_block.yml", "variables:\n  name:\n    presets: ../../etc/passwd\n")
      expect(await failure(dir)).toContain("outside the module")
    })

    it("with a file that doesn't parse", async () => {
      write("main.tf", 'resource "x" "y" {\n')
      expect(await failure(dir)).toContain("Couldn't parse main.tf")
    })

    it("whose runbook_block.yml is a newer version", async () => {
      write("runbook_block.yml", "version: 7\n")
      expect(await failure(dir)).toContain("can't read")
    })

    it("that isn't a module", async () => {
      nodeFs.rmSync(nodePath.join(dir, "variables.tf"))
      expect(await failure(dir)).toContain("isn't an OpenTofu module")
    })
  })

  it("warns about keys Runbooks doesn't know, and still loads", async () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "tf-module-"))
    try {
      nodeFs.writeFileSync(
        nodePath.join(dir, "variables.tf"),
        'variable "name" {\n  type = string\n}\n',
      )
      nodeFs.writeFileSync(
        nodePath.join(dir, "runbook_block.yml"),
        "variables:\n  name:\n    lable: Name\n",
      )
      const spec = await loaded(dir)
      expect(spec.warnings).toEqual([`variables.name: Runbooks doesn't know the key "lable".`])
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("warns about a source with no ref, and still loads", async () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "tf-module-"))
    try {
      nodeFs.writeFileSync(
        nodePath.join(dir, "variables.tf"),
        'variable "name" {\n  type = string\n}\n',
      )
      nodeFs.writeFileSync(
        nodePath.join(dir, "runbook_block.yml"),
        "source: git::https://github.com/acme/catalog.git//modules/group\n",
      )
      const spec = await loaded(dir)
      expect(spec.source).toBe("git::https://github.com/acme/catalog.git//modules/group")
      expect(spec.warnings).toEqual([
        "source has no ?ref=, so code in a repository follows the module's default branch. Pin it to a tag.",
      ])
    } finally {
      nodeFs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
