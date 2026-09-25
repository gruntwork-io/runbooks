import { describe, it, expect, afterEach } from "bun:test"
import {
  activeCredentialFor,
  resetGoogleCredentialRegistry,
  setActiveCredential,
} from "./google-credential-registry.ts"
import { commitBlockProject, sessionEnvForCredential } from "./google-session-env.ts"

/**
 * `google:set-project` against the real per-block registry. The documented
 * multi-project pattern puts `<GoogleAuth id="source"/>` next to
 * `<GoogleAuth id="target"/>`, and the session env belongs to whichever block
 * acted last. A project pick on `source` after `target` authenticated has to
 * move the WHOLE session back to `source`: writing only the project left
 * `target`'s credential and account paired with `source`'s project.
 */

const fileBacked = (path: string, principal: string, projectId?: string) => ({
  ref: { kind: "file", path } as const,
  credentialsPath: path,
  principal,
  credentialType: "service_account" as const,
  ...(projectId ? { projectId } : {}),
})

afterEach(() => {
  resetGoogleCredentialRegistry()
})

describe("commitBlockProject", () => {
  it("re-points the whole session at the calling block, not just its project", () => {
    setActiveCredential("source", fileBacked("/tmp/source/adc.json", "source@a.iam.gserviceaccount.com", "proj-a"))
    setActiveCredential("target", fileBacked("/tmp/target/adc.json", "target@b.iam.gserviceaccount.com", "proj-b"))

    const commit = commitBlockProject({ blockId: "source", projectId: "proj-a2" })

    expect(commit.env).toEqual({
      set: {
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/source/adc.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/source/adc.json",
        CLOUDSDK_CORE_ACCOUNT: "source@a.iam.gserviceaccount.com",
        GOOGLE_CLOUD_PROJECT: "proj-a2",
        CLOUDSDK_CORE_PROJECT: "proj-a2",
        GOOGLE_PROJECT: "proj-a2",
      },
      clear: [],
    })
    // Only the calling block's record moves.
    expect(activeCredentialFor("source")?.projectId).toBe("proj-a2")
    expect(activeCredentialFor("target")?.projectId).toBe("proj-b")
  })

  it("clears the gcloud file override a file-backed block left, for an access-token block", () => {
    setActiveCredential("source", {
      ref: { kind: "access_token", accessToken: "ya29.source-token" },
      principal: "dev@example.com",
      credentialType: "access_token",
      projectId: "proj-a",
    })
    setActiveCredential("target", fileBacked("/tmp/target/adc.json", "target@b.iam.gserviceaccount.com", "proj-b"))

    const commit = commitBlockProject({ blockId: "source", projectId: "proj-a" })

    expect(commit.env).toEqual({
      set: {
        GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.source-token",
        CLOUDSDK_AUTH_ACCESS_TOKEN: "ya29.source-token",
        CLOUDSDK_CORE_ACCOUNT: "dev@example.com",
        GOOGLE_CLOUD_PROJECT: "proj-a",
        CLOUDSDK_CORE_PROJECT: "proj-a",
        GOOGLE_PROJECT: "proj-a",
      },
      // `target`'s path would otherwise keep routing bare gcloud to its file.
      clear: ["CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"],
    })
  })

  it("keeps the region and zone the block authenticated with when none is sent", () => {
    setActiveCredential("gcp", {
      ...fileBacked("/home/u/.config/gcloud/application_default_credentials.json", "dev@example.com", "proj-a"),
      credentialType: "authorized_user",
      region: "europe-west1",
      zone: "europe-west1-b",
      configuration: "default",
    })

    const commit = commitBlockProject({ blockId: "gcp", projectId: "proj-b" })

    // Returned, so the block publishes the region its session env holds.
    expect(commit.region).toBe("europe-west1")
    expect(commit.zone).toBe("europe-west1-b")
    expect(commit.env.set).toMatchObject({
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

    const commit = commitBlockProject({ blockId: "gcp", projectId: "proj-b", region: "us-central1" })

    expect(commit.region).toBe("us-central1")
    expect(commit.env.set.GOOGLE_CLOUD_REGION).toBe("us-central1")
    expect(commitBlockProject({ blockId: "gcp", projectId: "proj-c" }).region).toBe("us-central1")
  })

  it("returns no region for a block that authenticated without one", () => {
    // Registration replaces a block's record wholesale, so a fresh OAuth or
    // service-account sign-in never inherits an earlier credential's region.
    setActiveCredential("gcp", { ...fileBacked("/tmp/gcp/adc.json", "dev@example.com"), region: "europe-west1" })
    setActiveCredential("gcp", fileBacked("/tmp/gcp/adc2.json", "dev@example.com"))

    const commit = commitBlockProject({ blockId: "gcp", projectId: "proj-b" })

    expect(commit.region).toBeUndefined()
    expect(commit.zone).toBeUndefined()
    expect(commit.env.set.GOOGLE_CLOUD_REGION).toBeUndefined()
  })

  it("never borrows a neighbour's credential for a block with none registered", () => {
    setActiveCredential("target", fileBacked("/tmp/target/adc.json", "target@b.iam.gserviceaccount.com", "proj-b"))

    const commit = commitBlockProject({ blockId: "source", projectId: "proj-a", region: "us-east1" })

    expect(commit).toEqual({
      env: {
        set: {
          GOOGLE_CLOUD_PROJECT: "proj-a",
          CLOUDSDK_CORE_PROJECT: "proj-a",
          GOOGLE_PROJECT: "proj-a",
          GOOGLE_CLOUD_REGION: "us-east1",
          CLOUDSDK_COMPUTE_REGION: "us-east1",
          GOOGLE_REGION: "us-east1",
        },
        clear: [],
      },
      region: "us-east1",
    })
    expect(activeCredentialFor("target")?.projectId).toBe("proj-b")
  })
})

describe("sessionEnvForCredential", () => {
  it("writes nothing empty and clears nothing for a file-backed credential with no extras", () => {
    expect(sessionEnvForCredential(fileBacked("/tmp/a/adc.json", "sa@p.iam.gserviceaccount.com"))).toEqual({
      set: {
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/a/adc.json",
        CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/tmp/a/adc.json",
        CLOUDSDK_CORE_ACCOUNT: "sa@p.iam.gserviceaccount.com",
      },
      clear: [],
    })
  })
})
