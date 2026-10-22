import { describe, it, expect } from "bun:test"
import { isWarmRenderablePath, partialsOutsideBundle } from "./warmEligibility.ts"

describe("partialsOutsideBundle", () => {
  it("reports a partial that reaches above the bundle root", () => {
    const files = {
      "_deps/role/boilerplate.yml": "partials:\n  - ../../partials/policy.hcl\n",
      "_deps/role/terragrunt.hcl": '{{ template "policy" . }}',
    }

    expect(partialsOutsideBundle(files)).toEqual([
      "_deps/role/boilerplate.yml: ../../partials/policy.hcl",
    ])
  })

  it("reports a plain partial path that is missing from the bundle", () => {
    const files = {
      "_deps/role/boilerplate.yml": "partials:\n  - partials/policy.hcl\n",
    }

    expect(partialsOutsideBundle(files)).toEqual([
      "_deps/role/boilerplate.yml: partials/policy.hcl",
    ])
  })

  it("accepts a partial the bundle contains", () => {
    const files = {
      "_deps/role/boilerplate.yml": "partials:\n  - ./partials/policy.hcl\n",
      "_deps/role/partials/policy.hcl": '{{ define "policy" }}x{{ end }}',
    }

    expect(partialsOutsideBundle(files)).toEqual([])
  })

  it("trusts a glob over a directory the bundle captured", () => {
    const files = {
      "boilerplate.yml": "partials:\n  - partials/*.hcl\n",
      "partials/policy.hcl": '{{ define "policy" }}x{{ end }}',
    }

    expect(partialsOutsideBundle(files)).toEqual([])
  })

  it("trusts a glob at the bundle root", () => {
    const files = {
      "boilerplate.yml": "partials:\n  - ./*.hcl\n",
    }

    expect(partialsOutsideBundle(files)).toEqual([])
  })

  it("reports a glob over a directory the bundle holds nothing under", () => {
    // Four `..` from a four-deep template land at the bundle root, where the
    // shared partials directory does not exist.
    const files = {
      "_deps/a/_deps/b/boilerplate.yml": "partials:\n  - ../../../../partials/*.hcl\n",
    }

    expect(partialsOutsideBundle(files)).toEqual([
      "_deps/a/_deps/b/boilerplate.yml: ../../../../partials/*.hcl",
    ])
  })

  it("reports a glob that escapes the bundle", () => {
    const files = {
      "_deps/a/boilerplate.yml": "partials:\n  - ../../../partials/*.hcl\n",
    }

    expect(partialsOutsideBundle(files)).toEqual([
      "_deps/a/boilerplate.yml: ../../../partials/*.hcl",
    ])
  })

  it("reports the catalog's shared partial exactly as the bundle presents it", () => {
    const files = {
      "_deps/lz/_deps/plan-role/boilerplate.yml":
        "partials:\n  - ../../../../partials/iam-policy-for-mgmt-acct-pipelines-plan-role.hcl\n",
      "_deps/lz/_deps/plan-role/terragrunt.hcl":
        '{{ template "iam-policy-for-mgmt-acct-pipelines-plan-role" . }}',
    }

    expect(partialsOutsideBundle(files)).toEqual([
      "_deps/lz/_deps/plan-role/boilerplate.yml: ../../../../partials/iam-policy-for-mgmt-acct-pipelines-plan-role.hcl",
    ])
  })

  it("ignores configs without partials, non-config files and unparsable YAML", () => {
    const files = {
      "boilerplate.yml": "variables:\n  - name: X\n    type: string\n",
      "_deps/x/boilerplate.yml": "partials: [\n",
      "README.md": "partials:\n  - ../nope.hcl\n",
    }

    expect(partialsOutsideBundle(files)).toEqual([])
  })
})

describe("isWarmRenderablePath", () => {
  it("accepts a concrete relative path", () => {
    expect(isWarmRenderablePath("management/root.hcl")).toBe(true)
  })

  it("rejects the collapsed path the analyzer emits for a templated filename", () => {
    expect(isWarmRenderablePath(".")).toBe(false)
    expect(isWarmRenderablePath("")).toBe(false)
    expect(isWarmRenderablePath(" ")).toBe(false)
  })

  it("rejects a path the analyzer left unrendered", () => {
    expect(isWarmRenderablePath("{{ .RootTerragruntFileName }}")).toBe(false)
  })
})
