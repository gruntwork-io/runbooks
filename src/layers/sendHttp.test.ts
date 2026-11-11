import { describe, it, expect, spyOn, afterEach } from "bun:test"
import { Effect } from "effect"
import { MAX_REPLY_BYTES, sendHttp } from "./sendHttp.ts"
import { AwsSdkClientLive } from "./AwsSdkClient.ts"
import { GoogleSdkClientLive } from "./GoogleSdkClient.ts"
import { AwsClient } from "../services/AwsClient.ts"
import { GoogleClient } from "../services/GoogleClient.ts"

/**
 * The live layers' sends, with fetch stubbed at the network boundary. Each
 * stub records the URL and init it was called with.
 */
type Fetched = { url: string; init: RequestInit }

let spy: { mockRestore: () => void } | undefined

function stubFetch(reply: () => Response) {
  const fetched: Fetched[] = []
  spy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
    fetched.push({ url, init })
    return reply()
  }) as never)
  return { fetched }
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>

afterEach(() => spy?.mockRestore())

describe("sendHttp", () => {
  it("doesn't follow redirects, and returns the answer whatever its status", async () => {
    const { fetched } = stubFetch(
      () => new Response("denied", { status: 403, headers: { "content-type": "text/plain" } }),
    )
    const reply = await sendHttp({ method: "GET", url: "https://example.com/x", headers: {} }, {})
    expect(reply).toEqual({ status: 403, contentType: "text/plain", body: "denied" })
    expect(fetched[0]?.init.redirect).toBe("manual")
  })

  it("refuses an answer larger than the cap", async () => {
    stubFetch(() => new Response(new Uint8Array(MAX_REPLY_BYTES + 1)))
    let caught: unknown
    try {
      await sendHttp({ method: "GET", url: "https://example.com/x", headers: {} }, {})
    } catch (err) {
      caught = err
    }
    expect(String(caught)).toContain("larger than 5 MB")
  })
})

describe("AwsSdkClient.sendSigned", () => {
  it("signs with SigV4 for the service and region it's given", async () => {
    const { fetched } = stubFetch(() => new Response("{}", { status: 200 }))
    await Effect.runPromise(
      Effect.flatMap(AwsClient, (aws) =>
        aws.sendSigned(
          { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "session" },
          { service: "sso", region: "us-east-2" },
          {
            method: "POST",
            url: "https://sso.us-east-2.amazonaws.com/",
            headers: { "x-amz-target": "SWBExternalService.ListInstances" },
            body: "{}",
          },
        ),
      ).pipe(Effect.provide(AwsSdkClientLive)),
    )
    const headers = headersOf(fetched[0]!.init)
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-2\/sso\/aws4_request, SignedHeaders=[^,]*host;[^,]*x-amz-target/,
    )
    expect(headers["x-amz-security-token"]).toBe("session")
    expect(headers.host).toBeUndefined()
    expect(fetched[0]?.init.body).toBe("{}")
  })
})

describe("GoogleSdkClient.sendAuthorized", () => {
  it("adds the access token and the quota project", async () => {
    const { fetched } = stubFetch(() => new Response("{}", { status: 200 }))
    await Effect.runPromise(
      Effect.flatMap(GoogleClient, (google) =>
        google.sendAuthorized(
          { kind: "access_token", accessToken: "ya29.token" },
          {
            method: "GET",
            url: "https://admin.googleapis.com/admin/directory/v1/users",
            headers: {},
          },
          "quota-project",
        ),
      ).pipe(Effect.provide(GoogleSdkClientLive)),
    )
    const headers = headersOf(fetched[0]!.init)
    expect(headers.authorization).toBe("Bearer ya29.token")
    expect(headers["x-goog-user-project"]).toBe("quota-project")
  })
})
