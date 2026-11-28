import { describe, it, expect } from "bun:test"
import { AWS_AUTH_ENV_VARS, applyEnvExports, authEnvExport } from "./authEnv.ts"

describe("authEnvExport", () => {
  it("sets the variables the sign-in has values for and clears the provider's others", () => {
    expect(
      authEnvExport("aws", {
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_SECRET_ACCESS_KEY: "secret",
        AWS_SESSION_TOKEN: "",
      }),
    ).toEqual({
      ok: true,
      export: {
        env: { AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "secret" },
        clears: ["AWS_REGION", "AWS_SESSION_TOKEN"],
      },
    })
  })

  it("refuses variables the provider doesn't export, naming them", () => {
    expect(
      authEnvExport("aws", { AWS_ACCESS_KEY_ID: "AKIA", PATH: "/evil", BASH_ENV: "/evil.sh" }),
    ).toEqual({ ok: false, error: "A aws sign-in can't export BASH_ENV, PATH" })
    expect(authEnvExport("github", { AWS_ACCESS_KEY_ID: "AKIA" }).ok).toBe(false)
  })

  it("clears every variable for a sign-in with no values", () => {
    expect(authEnvExport("aws", {})).toEqual({
      ok: true,
      export: { env: {}, clears: [...AWS_AUTH_ENV_VARS] },
    })
  })
})

describe("applyEnvExports", () => {
  const base = { PATH: "/usr/bin", AWS_ACCESS_KEY_ID: "AKIA_SHELL", AWS_PROFILE: "dev" }

  it("returns the base env for no exports, without changing it", () => {
    const env = applyEnvExports(base, [])
    expect(env).toEqual(base)
    expect(env).not.toBe(base)
  })

  it("removes what an export clears, then sets what it sets, later exports winning", () => {
    expect(
      applyEnvExports(base, [
        { env: { AWS_ACCESS_KEY_ID: "AKIA_FIRST", AWS_REGION: "us-east-1" }, clears: [] },
        { env: { AWS_ACCESS_KEY_ID: "AKIA_SECOND" }, clears: ["AWS_REGION", "AWS_PROFILE"] },
      ]),
    ).toEqual({ PATH: "/usr/bin", AWS_ACCESS_KEY_ID: "AKIA_SECOND" })
  })
})
