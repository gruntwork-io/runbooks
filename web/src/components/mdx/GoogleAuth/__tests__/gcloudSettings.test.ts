import { describe, it, expect } from "vitest"
import type { GcloudConfigInfo } from "../types"
import { describeGcloudSettings, toAdcPrincipalLookup, type GcloudSettingSources } from "../utils"

const configuration: GcloudConfigInfo = {
  name: "default",
  isActive: true,
  account: "dev@example.com",
  project: "proj-a",
  region: "us-central1",
  authType: "adc-user",
}

const nothingSet: GcloudSettingSources = {
  configuration: null,
  pinnedProject: undefined,
  quotaProject: undefined,
  pickedRegion: "",
  defaultRegion: undefined,
  defaultZone: undefined,
}

const FROM_CONFIGURATION = "from your gcloud configuration default"

describe("describeGcloudSettings", () => {
  it("takes the project and region from the configuration", () => {
    expect(describeGcloudSettings({ ...nothingSet, configuration })).toEqual([
      { label: "Project", value: "proj-a", source: FROM_CONFIGURATION },
      { label: "Region", value: "us-central1", source: FROM_CONFIGURATION },
    ])
  })

  it("says the project is chosen after sign-in when nothing names one", () => {
    expect(describeGcloudSettings(nothingSet)).toEqual([
      { label: "Project", value: "Chosen after sign-in" },
      { label: "Region", value: "Not set" },
    ])
  })

  it("puts the runbook's project over the configuration's", () => {
    const [project] = describeGcloudSettings({
      ...nothingSet,
      configuration,
      pinnedProject: "pinned-proj",
    })

    expect(project).toEqual({
      label: "Project",
      value: "pinned-proj",
      source: "set by this runbook",
    })
  })

  it("falls back to the project the login names when no configuration gives one", () => {
    const [project] = describeGcloudSettings({ ...nothingSet, quotaProject: "billing-proj" })

    expect(project).toEqual({
      label: "Project",
      value: "billing-proj",
      source: "from your gcloud login",
    })
  })

  it("tells a region the runbook set from one the reader picked", () => {
    const fromRunbook = {
      ...nothingSet,
      configuration,
      pickedRegion: "us-east1",
      defaultRegion: "us-east1",
    }
    const fromReader = { ...fromRunbook, pickedRegion: "europe-west1" }

    expect(describeGcloudSettings(fromRunbook)[1]).toEqual({
      label: "Region",
      value: "us-east1",
      source: "set by this runbook",
    })
    expect(describeGcloudSettings(fromReader)[1]).toEqual({
      label: "Region",
      value: "europe-west1",
      source: "your choice",
    })
  })

  it("adds a zone line only when a zone is set", () => {
    const withZone = { ...configuration, zone: "us-central1-a" }

    expect(describeGcloudSettings({ ...nothingSet, configuration })).toHaveLength(2)
    expect(describeGcloudSettings({ ...nothingSet, configuration: withZone })[2]).toEqual({
      label: "Zone",
      value: "us-central1-a",
      source: FROM_CONFIGURATION,
    })
    expect(describeGcloudSettings({ ...nothingSet, defaultZone: "us-east1-b" })[2]).toEqual({
      label: "Zone",
      value: "us-east1-b",
      source: "set by this runbook",
    })
  })
})

describe("toAdcPrincipalLookup", () => {
  it("reports missing scopes ahead of the credential being unusable", () => {
    const lookup = toAdcPrincipalLookup({
      found: true,
      valid: false,
      account: { principal: "dev@example.com" },
      missingScopes: ["https://www.googleapis.com/auth/drive"],
      error: "These credentials are missing required OAuth scopes",
    })

    expect(lookup).toEqual({
      status: "missing-scopes",
      principal: "dev@example.com",
      missingScopes: ["https://www.googleapis.com/auth/drive"],
    })
  })

  it("is missing when nothing was found, and unusable when the search itself failed", () => {
    expect(toAdcPrincipalLookup({ found: false })).toEqual({ status: "missing" })
    expect(toAdcPrincipalLookup({ found: false, error: "EACCES" })).toEqual({
      status: "unusable",
      reason: "EACCES",
    })
  })
})
