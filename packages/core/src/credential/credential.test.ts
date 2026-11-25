import { describe, expect, expectTypeOf, it } from "bun:test"
import { DateTime, Redacted, Schema } from "effect"
import { CredentialError, type CredentialErrorKind } from "@runbooks/blocks-core/contract"
import * as Wire from "../plugin/generated/credential.ts"
import {
  CredentialAction,
  type CredentialState,
  CredentialState as CredentialStateSchema,
  type CredentialStateTag,
  TRANSITIONS,
  confirmsDetected,
  statusOf,
} from "./lifecycle.ts"
import { Identity, Method, MethodField } from "./provider.ts"

const decode =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (input: unknown) =>
    Schema.decodeUnknownSync(schema)(input)

const identity = {
  principal: "arn:aws:sts::123456789012:assumed-role/Admin/me",
  kind: "role" as const,
  method: "sso",
  targets: { account: { id: "123456789012", name: "prod" }, role: { id: "Admin", name: "Admin" } },
}

describe("credential wire schema", () => {
  it("accepts the proposal's configure exchange for AWS", () => {
    const result = decode(Wire.ConfigureResult)({
      protocolVersion: "1",
      driverVersion: "0.1.0",
      cloud: "aws",
      methods: [
        {
          name: "sso",
          label: "SSO",
          fields: [
            { name: "startUrl", label: "Start URL", required: true, secret: false },
            { name: "region", label: "Region", required: true, secret: false },
          ],
        },
      ],
      levels: [
        { name: "account", label: "Account", chosen: "afterSignIn" },
        { name: "role", label: "Role", chosen: "afterSignIn" },
      ],
      sources: [],
      requirements: [],
      names: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION"],
    })
    expect(result.levels.map((l) => l.name)).toEqual(["account", "role"])
    expect(() =>
      decode(Wire.ConfigureParams)({ protocolVersion: "1", caller: "runbooks/0.31.0" }),
    ).toThrow()
  })

  it("gives a provider the block's settings when it is configured", () => {
    const params = decode(Wire.ConfigureParams)({
      protocolVersion: "1",
      caller: "runbooks/0.31.0",
      stateDir: "/state/s1/aws",
      settings: { defaultRegion: "eu-west-1" },
    })
    expect(params.settings).toEqual({ defaultRegion: "eu-west-1" })
    expect(() =>
      decode(Wire.ConfigureParams)({ ...params, settings: { defaultRegion: 1 } }),
    ).toThrow()
  })

  it("decodes detect, signIn.prompt, env and the error data a block branches on", () => {
    expect(decode(Wire.DetectResult)({ found: false }).found).toBe(false)
    expect(decode(Wire.DetectResult)({ found: true, identity, source: "env" }).found).toBe(true)
    expect(() => decode(Wire.DetectResult)({ found: true, source: "env" })).toThrow()
    expect(
      decode(Wire.SignInPrompt)({ request: 2, kind: "openUrl", url: "https://d.example/" }).kind,
    ).toBe("openUrl")
    const env = decode(Wire.EnvResult)({
      values: [{ name: "AWS_REGION", value: "us-east-1", sensitive: false, to: ["env", "output"] }],
      expiresAt: "2026-11-24T18:00:00Z",
    })
    expect(env.values[0]?.to).toEqual(["env", "output"])
    expect(
      decode(Wire.RequirementNotMetData)({
        kind: "requirementNotMet",
        unmet: [{ kind: "scopes", scopes: ["repo"] }],
      }).unmet,
    ).toHaveLength(1)
    expect(() => decode(Wire.ToolMissingData)({ kind: "toolMissing", tool: "az" })).toThrow()
  })

  it("carries at most 10 warnings with an identity, on the wire and in the engine", () => {
    const warned = (count: number) => ({
      ...identity,
      warnings: Array.from({ length: count }, (_, i) => ({
        message: `Region ${i} is not enabled.`,
      })),
    })
    for (const schema of [Wire.Identity, Identity]) {
      expect(decode(schema)(warned(10)).warnings).toHaveLength(10)
      expect(() => decode(schema)(warned(11))).toThrow()
    }
  })

  it("lets a field list at most 1,000 choices, and never on a secret field", () => {
    const profile = { name: "profile", label: "Profile", required: true }
    const choices = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ value: `p${i}`, label: `Profile ${i}` }))
    for (const schema of [Wire.Field, MethodField]) {
      expect(
        decode(schema)({ ...profile, secret: false, choices: choices(1000) }).choices,
      ).toHaveLength(1000)
      expect(() => decode(schema)({ ...profile, secret: false, choices: choices(1001) })).toThrow()
    }
    expect(() => decode(MethodField)({ ...profile, secret: true, choices: choices(1) })).toThrow()
  })

  it("lets a method ask for exactly one field of a group, naming only its own fields", () => {
    const servicePrincipal = {
      name: "servicePrincipal",
      label: "Service principal",
      fields: [
        { name: "clientId", label: "Client ID", required: true, secret: false },
        { name: "clientSecret", label: "Client secret", required: false, secret: true },
        { name: "certificate", label: "Certificate", required: false, secret: false },
      ],
      oneOf: [["clientSecret", "certificate"]],
    }
    for (const schema of [Wire.Method, Method]) {
      expect(decode(schema)(servicePrincipal).oneOf).toEqual([["clientSecret", "certificate"]])
      expect(() => decode(schema)({ ...servicePrincipal, oneOf: [["clientSecret"]] })).toThrow()
    }
    expect(() =>
      decode(Method)({ ...servicePrincipal, oneOf: [["clientSecret", "password"]] }),
    ).toThrow()
  })

  it("rejects an identity kind and a level timing it does not define", () => {
    expect(() => decode(Wire.Identity)({ ...identity, kind: "robot" })).toThrow()
    expect(() => decode(Wire.Level)({ name: "a", label: "A", chosen: "never" })).toThrow()
  })

  it("has no error kind the engine cannot name", () => {
    expectTypeOf<Wire.ErrorKind>().toExtend<CredentialErrorKind>()
  })
})

describe("credential lifecycle", () => {
  const json = Schema.toCodecJson(CredentialStateSchema)

  it("carries a state with an expiry through JSON", () => {
    const ready: CredentialState = {
      _tag: "Ready",
      source: "sso",
      identity: { ...identity, expiresAt: DateTime.makeUnsafe("2026-11-24T18:00:00Z") },
    }
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(json)(ready)))
    const back = Schema.decodeUnknownSync(json)(wire)
    expect(back._tag).toBe("Ready")
    if (back._tag !== "Ready" || back.identity.expiresAt === undefined) {
      throw new Error("expected Ready with an expiry")
    }
    expect(DateTime.toEpochMillis(back.identity.expiresAt)).toBe(Date.parse("2026-11-24T18:00:00Z"))
  })

  it("takes a secret sign-in field from a client as Redacted", () => {
    const action = Schema.decodeUnknownSync(Schema.toCodecJson(CredentialAction))({
      _tag: "SignIn",
      method: "pat",
      fields: { token: "glpat-not-a-real-token" },
    })
    if (action._tag !== "SignIn") throw new Error("expected SignIn")
    const token = action.fields["token"]
    if (token === undefined) throw new Error("expected a token field")
    expect(Redacted.value(token)).toBe("glpat-not-a-real-token")
    expect(JSON.stringify(action)).not.toContain("glpat")
  })

  it("can reach Ready from every state", () => {
    const tags = Object.keys(TRANSITIONS) as CredentialStateTag[]
    for (const start of tags) {
      const seen = new Set<CredentialStateTag>([start])
      const queue = [start]
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        for (const to of TRANSITIONS[next]) {
          if (!seen.has(to)) {
            seen.add(to)
            queue.push(to)
          }
        }
      }
      expect({ start, reachesReady: seen.has("Ready") }).toEqual({ start, reachesReady: true })
    }
  })

  it("holds an unmet requirement the provider reported without naming who lacks it", () => {
    const wire = Schema.encodeSync(json)({
      _tag: "RequirementNotMet",
      unmet: [{ kind: "scopes", scopes: ["repo"] }],
    })
    expect(Schema.decodeUnknownSync(json)(wire)._tag).toBe("RequirementNotMet")
  })

  it("lets a sign-in show its next prompt, and a refresh move a ready credential's expiry", () => {
    expect(TRANSITIONS.SigningIn).toContain("SigningIn")
    expect(TRANSITIONS.Ready).toContain("Ready")
  })

  it("publishes env only while Ready", () => {
    expect(statusOf({ _tag: "Ready", identity, source: "env" })).toEqual({
      _tag: "Done",
      outcome: "success",
    })
    const expired = statusOf({ _tag: "Expired", identity })
    expect(expired._tag === "Failed" && expired.error._tag).toBe("CredentialError")
    expect(
      expired._tag === "Failed" && expired.error instanceof CredentialError && expired.error.kind,
    ).toBe("expired")
    expect(statusOf({ _tag: "Found", identity, source: "env" })._tag).toBe("Idle")
  })

  it("asks to confirm a detected login only when the block pins nothing (decision 7)", () => {
    expect(confirmsDetected({ pins: {} })).toBe(true)
    expect(confirmsDetected({ pins: { account: "123456789012" } })).toBe(false)
  })
})
