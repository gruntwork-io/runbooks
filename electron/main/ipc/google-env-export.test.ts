import { describe, it, expect, afterEach } from "bun:test"
import { GOOGLE_AUTH_ENV_VARS } from "../../../src/domain/exec/authEnv.ts"
import {
  activeCredentialFor,
  resetGoogleCredentialRegistry,
  setActiveCredential,
} from "./google-credential-registry.ts"
import { commitBlockProject, exportForCredential } from "./google-env-export.ts"

/**
 * A GoogleAuth block's export against the real per-block registry. The
 * documented multi-project pattern puts `<GoogleAuth id="source"/>` next to
 * `<GoogleAuth id="target"/>`, and a script names one of them in envFrom, so
 * each block's export carries its own credential, account and project, and
 * clears every other Google variable.
 */

const fileBacked = (path: string, principal: string, projectId?: string) => ({
  ref: { kind: "file", path } as const,
  credentialsPath: path,
  principal,
  credentialType: "service_account" as const,
  ...(projectId ? { projectId } : {}),
})

/** The export that sets `env` and clears the rest of Google's variables. */
const exportOf = (env: Record<string, string>) => ({
  env,
  clears: GOOGLE_AUTH_ENV_VARS.filter((name) => env[name] === undefined),
})

afterEach(() => {
  resetGoogleCredentialRegistry()
})

describe("commitBlockProject", () => {
  it("exports the calling block's whole credential with the new project, and changes no other block", () => {
    setActiveCredential(
      "source",
      fileBacked("/tmp/source/adc.json", "source@a.iam.gserviceaccount.com", "proj-a"),
    )
    setActiveCredential(
      "target",
      fileBacked("/tmp/target/adc.json", "target@b.iam.gserviceaccount.com", "proj-b"),
    )

    const commit = commitBlockProject({ blockId: "source", projectId: "proj-a2" })

    expect(commit.envExport).toEqual(
      exportOf({
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/source/adc.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/source/adc.json",
        CLOUDSDK_CORE_ACCOUNT: "source@a.iam.gserviceaccount.com",
        GOOGLE_CLOUD_PROJECT: "proj-a2",
        CLOUDSDK_CORE_PROJECT: "proj-a2",
        GOOGLE_PROJECT: "proj-a2",
      }),
    )
    expect(activeCredentialFor("source")?.projectId).toBe("proj-a2")
    expect(activeCredentialFor("target")?.projectId).toBe("proj-b")
  })

  it("exports an access token, and clears the credential file variables", () => {
    setActiveCredential("source", {
      ref: { kind: "access_token", accessToken: "ya29.source-token" },
      principal: "dev@example.com",
      credentialType: "access_token",
      projectId: "proj-a",
    })

    const commit = commitBlockProject({ blockId: "source", projectId: "proj-a" })

    expect(commit.envExport).toEqual(
      exportOf({
        GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.source-token",
        CLOUDSDK_AUTH_ACCESS_TOKEN: "ya29.source-token",
        CLOUDSDK_CORE_ACCOUNT: "dev@example.com",
        GOOGLE_CLOUD_PROJECT: "proj-a",
        CLOUDSDK_CORE_PROJECT: "proj-a",
        GOOGLE_PROJECT: "proj-a",
      }),
    )
    expect(commit.envExport.clears).toContain("GOOGLE_APPLICATION_CREDENTIALS")
    expect(commit.envExport.clears).toContain("CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE")
  })

  it("keeps the region and zone the block authenticated with when none is sent", () => {
    setActiveCredential("gcp", {
      ...fileBacked(
        "/home/u/.config/gcloud/application_default_credentials.json",
        "dev@example.com",
        "proj-a",
      ),
      credentialType: "authorized_user",
      region: "europe-west1",
      zone: "europe-west1-b",
      configuration: "default",
    })

    const commit = commitBlockProject({ blockId: "gcp", projectId: "proj-b" })

    // Returned, so the block publishes the region its export holds.
    expect(commit.region).toBe("europe-west1")
    expect(commit.zone).toBe("europe-west1-b")
    expect(commit.envExport.env).toMatchObject({
      GOOGLE_CLOUD_PROJECT: "proj-b",
      GOOGLE_CLOUD_REGION: "europe-west1",
      CLOUDSDK_COMPUTE_REGION: "europe-west1",
      GOOGLE_REGION: "europe-west1",
      CLOUDSDK_COMPUTE_ZONE: "europe-west1-b",
      GOOGLE_ZONE: "europe-west1-b",
      CLOUDSDK_ACTIVE_CONFIG_NAME: "default",
    })
  })

  it("a requested region replaces the block's own, and sticks", () => {
    setActiveCredential("gcp", {
      ...fileBacked("/tmp/gcp/adc.json", "dev@example.com"),
      region: "europe-west1",
    })

    const commit = commitBlockProject({
      blockId: "gcp",
      projectId: "proj-b",
      region: "us-central1",
    })

    expect(commit.region).toBe("us-central1")
    expect(commit.envExport.env.GOOGLE_CLOUD_REGION).toBe("us-central1")
    expect(commitBlockProject({ blockId: "gcp", projectId: "proj-c" }).region).toBe("us-central1")
  })

  it("returns no region for a block that authenticated without one, and clears the region variables", () => {
    // Registration replaces a block's record wholesale, so a fresh OAuth or
    // service-account sign-in never inherits an earlier credential's region.
    setActiveCredential("gcp", {
      ...fileBacked("/tmp/gcp/adc.json", "dev@example.com"),
      region: "europe-west1",
    })
    setActiveCredential("gcp", fileBacked("/tmp/gcp/adc2.json", "dev@example.com"))

    const commit = commitBlockProject({ blockId: "gcp", projectId: "proj-b" })

    expect(commit.region).toBeUndefined()
    expect(commit.zone).toBeUndefined()
    expect(commit.envExport.env.GOOGLE_CLOUD_REGION).toBeUndefined()
    expect(commit.envExport.clears).toContain("GOOGLE_CLOUD_REGION")
  })

  it("never borrows a neighbour's credential for a block with none registered", () => {
    setActiveCredential(
      "target",
      fileBacked("/tmp/target/adc.json", "target@b.iam.gserviceaccount.com", "proj-b"),
    )

    const commit = commitBlockProject({
      blockId: "source",
      projectId: "proj-a",
      region: "us-east1",
    })

    expect(commit).toEqual({
      envExport: exportOf({
        GOOGLE_CLOUD_PROJECT: "proj-a",
        CLOUDSDK_CORE_PROJECT: "proj-a",
        GOOGLE_PROJECT: "proj-a",
        GOOGLE_CLOUD_REGION: "us-east1",
        CLOUDSDK_COMPUTE_REGION: "us-east1",
        GOOGLE_REGION: "us-east1",
      }),
      region: "us-east1",
    })
    expect(activeCredentialFor("target")?.projectId).toBe("proj-b")
  })
})

describe("exportForCredential", () => {
  it("sets nothing empty for a file-backed credential with no extras, and clears the rest", () => {
    expect(
      exportForCredential(fileBacked("/tmp/a/adc.json", "sa@p.iam.gserviceaccount.com")),
    ).toEqual(
      exportOf({
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/a/adc.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/a/adc.json",
        CLOUDSDK_CORE_ACCOUNT: "sa@p.iam.gserviceaccount.com",
      }),
    )
  })
})
