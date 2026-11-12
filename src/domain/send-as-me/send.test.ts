import { describe, it, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { sendAsAws, sendAsGoogle } from "./send.ts"
import { makeTestAwsClient, makeTestGoogleClient } from "../../test-utils/TestLayer.ts"
import type { HttpRequest } from "../../services/HttpRequest.ts"

const CREDS = { accessKeyId: "AKID", secretAccessKey: "secret" }
const REPLY = { status: 200, contentType: "application/json", body: "{}" }

describe("sendAsAws", () => {
  it("signs an allowed read for the service and region its host names", async () => {
    const calls: unknown[] = []
    const layer = makeTestAwsClient({
      sendSigned: (creds, signing, request) => {
        calls.push({ creds, signing, request })
        return Effect.succeed(REPLY)
      },
    })
    const request: HttpRequest = {
      method: "POST",
      url: "https://organizations.us-east-1.amazonaws.com/",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSOrganizationsV20161128.ListAccounts",
      },
      body: "{}",
    }
    const reply = await Effect.runPromise(sendAsAws(CREDS, request).pipe(Effect.provide(layer)))
    expect(reply).toEqual(REPLY)
    expect(calls).toEqual([
      {
        creds: CREDS,
        signing: { service: "organizations", region: "us-east-1" },
        request: {
          ...request,
          headers: {
            "content-type": "application/x-amz-json-1.1",
            "x-amz-target": "AWSOrganizationsV20161128.ListAccounts",
          },
        },
      },
    ])
  })

  it("never reaches AWS with a refused request", async () => {
    let sent = false
    const layer = makeTestAwsClient({
      sendSigned: () => {
        sent = true
        return Effect.succeed(REPLY)
      },
    })
    const exit = await Effect.runPromiseExit(
      sendAsAws(CREDS, {
        method: "GET",
        url: "https://iam.amazonaws.com/?Action=DeleteRole",
        headers: {},
      }).pipe(Effect.provide(layer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("RequestRefusedError")
    expect(sent).toBe(false)
  })
})

describe("sendAsGoogle", () => {
  it("sends an allowed read billed to the quota project", async () => {
    const calls: unknown[] = []
    const layer = makeTestGoogleClient({
      sendAuthorized: (creds, request, quotaProjectId) => {
        calls.push({ creds, request, quotaProjectId })
        return Effect.succeed(REPLY)
      },
    })
    const creds = { kind: "access_token", accessToken: "token" } as const
    const request: HttpRequest = {
      method: "GET",
      url: "https://serviceusage.googleapis.com/v1/projects/p/services/admin.googleapis.com",
      headers: {},
    }
    await Effect.runPromise(sendAsGoogle(creds, request, "p").pipe(Effect.provide(layer)))
    expect(calls).toEqual([{ creds, request, quotaProjectId: "p" }])
  })

  it("never reaches Google with a refused request", async () => {
    let sent = false
    const layer = makeTestGoogleClient({
      sendAuthorized: () => {
        sent = true
        return Effect.succeed(REPLY)
      },
    })
    const exit = await Effect.runPromiseExit(
      sendAsGoogle(
        { kind: "access_token", accessToken: "token" },
        {
          method: "POST",
          url: "https://admin.googleapis.com/admin/directory/v1/groups",
          headers: {},
          body: "{}",
        },
      ).pipe(Effect.provide(layer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(sent).toBe(false)
  })
})
