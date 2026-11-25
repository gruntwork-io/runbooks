import { describe, expect, it } from "bun:test"
import { Option, Schema } from "effect"
import {
  ConfigureParams,
  ConfigureResult,
  ErrorResponse,
  Notification,
  Request,
  ResultResponse,
} from "./generated/base.ts"
import { LIMITS, PluginEntry, PluginTransportError } from "./transport.ts"

const decode =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (input: unknown) =>
    Schema.decodeUnknownSync(schema)(input)

describe("wire messages", () => {
  it("accept the plan's examples", () => {
    expect(
      decode(Request)({
        jsonrpc: "2.0",
        id: 1,
        method: "configure",
        params: { protocolVersion: "1", caller: "runbooks/0.31.0", stateDir: "/s" },
      }).method,
    ).toBe("configure")
    expect(
      decode(Notification)({
        jsonrpc: "2.0",
        method: "signIn.prompt",
        params: { request: 2, kind: "openUrl", url: "https://device.example/", code: "ABCD-EFGH" },
      }).params.request,
    ).toBe(2)
    expect(
      decode(ErrorResponse)({
        jsonrpc: "2.0",
        id: 2,
        error: { code: -32000, message: "Sign-in timed out", data: { kind: "timedOut" } },
      }).error.data.kind,
    ).toBe("timedOut")
    expect(decode(ResultResponse)({ jsonrpc: "2.0", id: "a", result: {} }).id).toBe("a")
  })

  it("accept an error with a null id, for a line the plugin could not read as a request", () => {
    const notJson = decode(ErrorResponse)({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "the line is not JSON", data: { kind: "invalidParams" } },
    })
    expect(notJson.id).toBeNull()
    expect(notJson.error.code).toBe(-32700)
  })

  it("keep fields they do not know", () => {
    const params = decode(ConfigureParams)({
      protocolVersion: "1",
      caller: "runbooks/0.31.0",
      stateDir: "/s",
    })
    expect(params).toEqual({ protocolVersion: "1", caller: "runbooks/0.31.0", stateDir: "/s" })
  })

  it("reject a request with no id, a notification that names no request, and an unknown error code", () => {
    expect(() => decode(Request)({ jsonrpc: "2.0", method: "detect" })).toThrow()
    expect(() =>
      decode(Notification)({
        jsonrpc: "2.0",
        method: "signIn.prompt",
        params: { kind: "waiting" },
      }),
    ).toThrow()
    expect(() =>
      decode(ErrorResponse)({
        jsonrpc: "2.0",
        id: 1,
        error: { code: 1, message: "x", data: { kind: "internal" } },
      }),
    ).toThrow()
    expect(() => decode(ConfigureResult)({ protocolVersion: "1" })).toThrow()
  })
})

describe("PluginEntry", () => {
  const sha = "a".repeat(64)
  it("pins one SHA-256 per platform", () => {
    const entry = decode(PluginEntry)({
      name: "aws-signin",
      kind: "credential",
      version: "0.1.0",
      sha256: { "darwin-arm64": sha, "linux-amd64": sha },
    })
    expect(Object.keys(entry.sha256)).toEqual(["darwin-arm64", "linux-amd64"])
  })

  it("rejects an unknown platform, a short hash and an unknown kind", () => {
    const base = { name: "x", kind: "credential", version: "1" }
    expect(() => decode(PluginEntry)({ ...base, sha256: { "plan9-mips": sha } })).toThrow()
    expect(() => decode(PluginEntry)({ ...base, sha256: { "linux-amd64": "abc" } })).toThrow()
    expect(() => decode(PluginEntry)({ ...base, kind: "task", sha256: {} })).toThrow()
  })
})

describe("transport errors", () => {
  it("are a closed set a caller branches on by tag", () => {
    const error = decode(PluginTransportError)({
      _tag: "PluginHashMismatch",
      plugin: "aws-signin",
      expected: "a",
      actual: "b",
    })
    expect(error._tag).toBe("PluginHashMismatch")
    // Not `toThrow`: Bun's passes when the function returns an Error, and a decoded one is.
    const gone = Schema.decodeUnknownOption(PluginTransportError)({
      _tag: "PluginGone",
      plugin: "x",
    })
    expect(Option.isNone(gone)).toBe(true)
  })

  it("name no offered version for a plugin that refused this app's", () => {
    const refused = decode(PluginTransportError)({
      _tag: "PluginUnsupportedProtocolVersion",
      plugin: "aws",
      supported: "1",
    })
    expect(refused).toMatchObject({ _tag: "PluginUnsupportedProtocolVersion", supported: "1" })
    expect("offered" in refused).toBe(false)
  })

  it("are too large for a line or a stream's items, and never for standard error", () => {
    const tooLarge = { _tag: "PluginTooLarge", plugin: "aws", max: 1 }
    for (const limit of ["line", "streamItems"]) {
      expect(decode(PluginTransportError)({ ...tooLarge, limit })).toMatchObject({ limit })
    }
    const stderr = Schema.decodeUnknownOption(PluginTransportError)({
      ...tooLarge,
      limit: "stderr",
    })
    expect(Option.isNone(stderr)).toBe(true)
  })
})

describe("limits", () => {
  /** How long runbooks-plugins gives a plugin to stop what it started once standard input closes: Azure's `az` group. */
  const PLUGIN_CLEANUP_MILLIS = 3_000

  it("give a plugin longer to exit than runbooks-plugins gives itself to stop what it started", () => {
    // At 2 s the owner killed the Azure plugin while it was still killing `az`, and `az` was orphaned.
    expect(LIMITS.exitGraceMillis).toBeGreaterThanOrEqual(PLUGIN_CLEANUP_MILLIS + 2_000)
  })
})
