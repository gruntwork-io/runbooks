import { describe, it, expect } from "bun:test"
import * as http from "node:http"
import { Effect, Either } from "effect"
import {
  GoogleSdkClientLive,
  classifyProjectAccessError,
  describeCredentialFailure,
  isPlausibleOAuthCallback,
  isSelectableProject,
} from "./GoogleSdkClient.ts"
import { GoogleClient } from "../services/GoogleClient.ts"
import type { GoogleClientShape } from "../services/GoogleClient.ts"

/**
 * Found against a real GCP org: `projects:search` returned a DELETE_REQUESTED
 * project inline with six live ones, and the picker offered it as an ordinary
 * choice. Selecting it would bind a whole runbook to a project being torn down.
 */
describe("isSelectableProject", () => {
  const project = (state?: string) => ({ projectId: "p", displayName: "p", state })

  it("offers ACTIVE projects", () => {
    expect(isSelectableProject(project("ACTIVE"))).toBe(true)
  })

  it("hides projects pending deletion", () => {
    expect(isSelectableProject(project("DELETE_REQUESTED"))).toBe(false)
  })

  it("keeps a project whose state the API omitted rather than guessing", () => {
    expect(isSelectableProject(project(undefined))).toBe(true)
  })
})

/**
 * Regression: a stale `application_default_credentials.json` is the single most
 * common way this block fails in the field, and google-auth-library reports it
 * as a raw JSON body. These cases pin that the user is told which command fixes
 * it instead of being shown `{"error":"invalid_grant","error_subtype":...}`.
 *
 * The real-world trigger: `gcloud auth login` refreshes the CLI's own
 * credentials.db but does NOT touch the ADC file, so ADC goes stale while
 * gcloud itself keeps working.
 */
describe("describeCredentialFailure", () => {
  // Verbatim body returned by Google's token endpoint for an expired RAPT.
  const raptError = new Error(
    '{"error":"invalid_grant","error_description":"reauth related error (invalid_rapt)","error_subtype":"invalid_rapt"}',
  )

  it("tells an ADC user the exact command that refreshes their credentials", () => {
    const msg = describeCredentialFailure(raptError, "adc")
    expect(msg).toContain("gcloud auth application-default login")
    expect(msg).not.toContain("invalid_rapt")
  })

  it("does not tell a service-account user to run a gcloud user-login command", () => {
    const msg = describeCredentialFailure(new Error('{"error":"invalid_grant"}'), "service_account")
    expect(msg).toContain("revoked")
    expect(msg).not.toContain("application-default login")
  })

  it("distinguishes a reauth demand from a dead grant", () => {
    expect(describeCredentialFailure(raptError, "adc")).toContain("reauthentication")
    expect(describeCredentialFailure(new Error('{"error":"invalid_grant"}'), "adc")).toContain(
      "expired or been revoked",
    )
  })

  it("maps client, scope, and network failures", () => {
    expect(describeCredentialFailure(new Error('{"error":"invalid_client"}'))).toContain("oauthClientId")
    expect(describeCredentialFailure(new Error('{"error":"invalid_scope"}'))).toContain("cloud-platform")
    expect(describeCredentialFailure(new Error("getaddrinfo ENOTFOUND oauth2.googleapis.com"))).toContain(
      "network",
    )
  })

  it("returns undefined for unrecognised errors so the caller keeps its own message", () => {
    expect(describeCredentialFailure(new Error("something else entirely"))).toBeUndefined()
  })
})

/**
 * `checkProject` is the `aws:check-region` analogue, and AwsSdkClient
 * deliberately FAILS OPEN (`catch: () => true`) so a transient error never
 * renders a false "not accessible" warning on the success card. These cases pin
 * the equivalent discipline: only an answer that names THIS project as missing
 * or forbidden may become `denied`.
 */
describe("classifyProjectAccessError", () => {
  const gaxios = (status: number, reason?: string): unknown => ({
    status,
    response: {
      status,
      data: reason ? { error: { status: reason, message: "boom" } } : {},
    },
  })

  it("treats a 404 on the project as denied", () => {
    expect(classifyProjectAccessError(gaxios(404, "NOT_FOUND"))).toBe("denied")
  })

  it("treats a bare 403 as denied", () => {
    expect(classifyProjectAccessError(gaxios(403))).toBe("denied")
  })

  it("treats an explicit PERMISSION_DENIED as denied", () => {
    expect(classifyProjectAccessError(gaxios(403, "PERMISSION_DENIED"))).toBe("denied")
  })

  it("does NOT blame the project when the Resource Manager API is disabled", () => {
    // Google's default for a brand-new project: cloudresourcemanager.googleapis.com
    // is off, the call 403s, and every gcloud/OpenTofu command in the runbook
    // still works fine.
    expect(classifyProjectAccessError(gaxios(403, "SERVICE_DISABLED"))).toBe("unknown")
  })

  it("does NOT blame the project for an unauthenticated or throttled call", () => {
    expect(classifyProjectAccessError(gaxios(401, "UNAUTHENTICATED"))).toBe("unknown")
    expect(classifyProjectAccessError(gaxios(429, "RESOURCE_EXHAUSTED"))).toBe("unknown")
  })

  it("does NOT blame the project for a server error or a dropped connection", () => {
    expect(classifyProjectAccessError(gaxios(500))).toBe("unknown")
    expect(classifyProjectAccessError(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }))).toBe(
      "unknown",
    )
    expect(classifyProjectAccessError(undefined)).toBe("unknown")
  })

  it("reads the status off a legacy response-only error shape", () => {
    expect(classifyProjectAccessError({ response: { status: 404 } })).toBe("denied")
  })
})

// ---------------------------------------------------------------------------
// Live-layer harness
// ---------------------------------------------------------------------------

const run = <A, E>(f: (client: GoogleClientShape) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(Effect.provide(Effect.flatMap(GoogleClient, f), GoogleSdkClientLive))

const runEither = <A, E>(
  f: (client: GoogleClientShape) => Effect.Effect<A, E>,
): Promise<Either.Either<A, E>> =>
  Effect.runPromise(Effect.provide(Effect.either(Effect.flatMap(GoogleClient, f)), GoogleSdkClientLive))

/** A single request against the loopback listener, with full control of headers. */
function probe(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (res) => {
        res.resume()
        res.on("end", () => {
          resolve(res.statusCode ?? 0)
        })
      },
    )
    req.on("error", reject)
    req.end()
  })
}

/** What a browser sends on a TOP-LEVEL navigation, which is what the redirect is. */
const BROWSER_NAVIGATION = {
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  // Cross-site, because the navigation arrives from accounts.google.com. The
  // handler must not treat this as suspicious.
  "sec-fetch-site": "cross-site",
}

/**
 * Security regression suite for the loopback listener.
 *
 * The listener binds an ephemeral 127.0.0.1 port that ANY page the user has
 * open in ANY browser tab can reach — `fetch('http://127.0.0.1:'+p+'/oauth2callback',
 * {mode:'no-cors'})` across the ephemeral range delivers the request even
 * though the response is unreadable. The original implementation called
 * `finishFlow(failed)` on the first wrong-`state` request, so one stray GET
 * from an unrelated tab (or a browser prefetch, or a reloaded callback tab from
 * an earlier flow) killed a sign-in that was still in progress and showed the
 * user a CSRF warning that had nothing to do with them.
 *
 * The rule these cases pin: unauthenticated input may end a REQUEST, never the
 * FLOW. Only the TTL, an explicit cancel, or a callback that proves it knows
 * `state` is allowed to be terminal.
 */
describe("the OAuth loopback listener", () => {
  const startFlow = () =>
    run((client) =>
      client.startOAuthFlow({
        clientId: "test-client.apps.googleusercontent.com",
        clientSecret: "test-secret",
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      }),
    )

  it("answers hostile probes without consuming the flow, then honours the real callback", async () => {
    const start = await startFlow()
    const port = Number(new URL(start.redirectUri).port)
    const state = new URL(start.authUrl).searchParams.get("state")
    expect(state).toBeTruthy()
    // Only the opaque flowId crosses IPC; the state nonce never does.
    expect(state).not.toBe(start.flowId)

    const expectStillPending = async (): Promise<void> => {
      const polled = await run((client) => client.pollOAuthFlow(start.flowId))
      expect(polled.status).toBe("pending")
    }

    try {
      // 1. The exact spray a malicious page performs: right path, wrong state.
      expect(await probe(port, "/oauth2callback?state=x", { headers: BROWSER_NAVIGATION })).toBe(400)
      await expectStillPending()

      // 2. No query string at all — "" vs a UUID also fails the state compare.
      expect(await probe(port, "/oauth2callback", { headers: BROWSER_NAVIGATION })).toBe(400)
      await expectStillPending()

      // 3. A stray path (favicon probes) was already handled; keep it pinned.
      expect(await probe(port, "/favicon.ico", { headers: BROWSER_NAVIGATION })).toBe(404)
      await expectStillPending()

      // 4. A no-cors `fetch` probe: correct state would not help it, but the
      //    fetch-metadata check drops it before the state compare even runs.
      expect(
        await probe(port, `/oauth2callback?state=${state}`, {
          headers: { "sec-fetch-dest": "empty", "sec-fetch-mode": "no-cors" },
        }),
      ).toBe(404)
      await expectStillPending()

      // 5. An <img> probe.
      expect(
        await probe(port, `/oauth2callback?state=${state}`, {
          headers: { "sec-fetch-dest": "image", "sec-fetch-mode": "no-cors" },
        }),
      ).toBe(404)
      await expectStillPending()

      // 6. DNS rebinding: the request reaches 127.0.0.1 but carries the
      //    attacker's hostname in Host.
      expect(
        await probe(port, `/oauth2callback?state=${state}`, {
          headers: { ...BROWSER_NAVIGATION, host: "rebound.attacker.example" },
        }),
      ).toBe(404)
      await expectStillPending()

      // 7. Anything that is not a GET.
      expect(
        await probe(port, `/oauth2callback?state=${state}`, {
          method: "POST",
          headers: BROWSER_NAVIGATION,
        }),
      ).toBe(404)
      await expectStillPending()

      // 8. The listener is still live and still works: a callback that knows
      //    `state` is the ONLY thing that moves the flow.
      expect(
        await probe(port, `/oauth2callback?state=${state}&error=access_denied`, {
          headers: BROWSER_NAVIGATION,
        }),
      ).toBe(200)
      const finished = await run((client) => client.pollOAuthFlow(start.flowId))
      expect(finished.status).toBe("failed")
      expect(finished.error).toContain("access_denied")
    } finally {
      await run((client) => client.cancelOAuthFlow(start.flowId))
    }
  })

  it("still fails a flow the user cancels", async () => {
    const start = await startFlow()
    await run((client) => client.cancelOAuthFlow(start.flowId))
    const polled = await run((client) => client.pollOAuthFlow(start.flowId))
    expect(polled.status).toBe("failed")
  })
})

describe("isPlausibleOAuthCallback", () => {
  const HOST = "127.0.0.1:54321"
  const req = (
    headers: Record<string, string | string[]>,
    method = "GET",
  ): { method: string; headers: Record<string, string | string[]> } => ({ method, headers })

  it("accepts the redirect a browser actually sends", () => {
    expect(
      isPlausibleOAuthCallback(
        req({ host: HOST, "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site" }),
        HOST,
      ),
    ).toBe(true)
  })

  it("accepts a client that sends no fetch-metadata headers at all", () => {
    // curl, and browsers too old to implement Fetch Metadata. Refusing these
    // would break real sign-ins to buy nothing.
    expect(isPlausibleOAuthCallback(req({ host: HOST }), HOST)).toBe(true)
  })

  it("does NOT require Sec-Fetch-Site to be same-origin", () => {
    // The redirect comes from accounts.google.com, so it is cross-site by
    // construction. This is the check that would have broken every real login.
    expect(
      isPlausibleOAuthCallback(req({ host: HOST, "sec-fetch-site": "cross-site" }), HOST),
    ).toBe(true)
  })

  it("rejects subresource probes", () => {
    expect(isPlausibleOAuthCallback(req({ host: HOST, "sec-fetch-dest": "image" }), HOST)).toBe(false)
    expect(isPlausibleOAuthCallback(req({ host: HOST, "sec-fetch-mode": "no-cors" }), HOST)).toBe(false)
  })

  it("rejects a repeated fetch-metadata header", () => {
    expect(
      isPlausibleOAuthCallback(req({ host: HOST, "sec-fetch-dest": ["document", "image"] }), HOST),
    ).toBe(false)
  })

  it("rejects a mismatched or missing Host", () => {
    expect(isPlausibleOAuthCallback(req({ host: "attacker.example" }), HOST)).toBe(false)
    expect(isPlausibleOAuthCallback(req({ host: "127.0.0.1:1" }), HOST)).toBe(false)
    expect(isPlausibleOAuthCallback(req({}), HOST)).toBe(false)
  })

  it("rejects anything that is not a GET", () => {
    expect(isPlausibleOAuthCallback(req({ host: HOST }, "POST"), HOST)).toBe(false)
    expect(isPlausibleOAuthCallback(req({ host: HOST }, "HEAD"), HOST)).toBe(false)
  })
})

/**
 * Security regression: an `external_account` document is not data, it is a
 * program — it names the URL google-auth-library must call, the headers it must
 * send, and the local file it must read. google-auth-library v11 validates none
 * of it, so before `assertFederatedCredentialAllowed` a credentials JSON the
 * user pasted (or file-picked) was an arbitrary outbound request plus an
 * arbitrary file read issued from the unsandboxed Electron main process.
 *
 * The rule: the document is rejected BEFORE any request is issued.
 */
describe("validateAdcDocument rejects federated credentials that steer the library", () => {
  /** Stands in for the attacker's collector AND for an internal SSRF target. */
  async function withSink<A>(f: (origin: string, hits: () => number) => Promise<A>): Promise<A> {
    let hits = 0
    const server = http.createServer((_req, res) => {
      hits += 1
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ access_token: "leaked", expires_in: 3600 }))
    })
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve)
    })
    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    try {
      return await f(`http://127.0.0.1:${port}`, () => hits)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }
  }

  it("never contacts an attacker-chosen token_url or credential_source.url", async () => {
    await withSink(async (origin, hits) => {
      const document = JSON.stringify({
        type: "external_account",
        audience: "//iam.googleapis.com/x",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_url: `${origin}/sts`,
        credential_source: {
          url: `${origin}/metadata`,
          headers: { "Metadata-Flavor": "Google" },
          format: { type: "json", subject_token_field_name: "access_token" },
        },
      })

      const result = await runEither((client) => client.validateAdcDocument(document))
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) expect(result.left.message).toContain("credential_source")
      expect(hits()).toBe(0)
    })
  })

  it("never reads a local file named by credential_source", async () => {
    await withSink(async (origin, hits) => {
      const document = JSON.stringify({
        type: "external_account",
        audience: "//iam.googleapis.com/x",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_url: `${origin}/sts`,
        credential_source: { file: "/etc/hosts", format: { type: "text" } },
      })

      const result = await runEither((client) => client.validateAdcDocument(document))
      expect(Either.isLeft(result)).toBe(true)
      expect(hits()).toBe(0)
    })
  })

  it("rejects an impersonated document that redirects iamcredentials", async () => {
    await withSink(async (origin, hits) => {
      const document = JSON.stringify({
        type: "impersonated_service_account",
        endpoint: origin,
        service_account_impersonation_url:
          "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken",
        source_credentials: {
          type: "authorized_user",
          client_id: "id.apps.googleusercontent.com",
          client_secret: "secret",
          refresh_token: "1//refresh",
        },
      })

      const result = await runEither((client) => client.validateAdcDocument(document))
      expect(Either.isLeft(result)).toBe(true)
      // Assert the POLICY rejected it, not merely that something failed. A bare
      // isLeft() passes with the gate disabled too: the planted refresh_token
      // dies at Google's real token endpoint long before `endpoint` is reached,
      // so that assertion alone proves nothing about the gate.
      if (Either.isLeft(result)) {
        // Only assertGoogleApiUrl phrases a rejection this way, and it names the
        // offending field. (The https: check fires before the host check here,
        // so matching on "not a Google API endpoint" would miss.)
        expect(result.left.message).toMatch(/credentials document field "endpoint"/)
      }
      expect(hits()).toBe(0)
    })
  })
})
