import { describe, it, expect } from "bun:test"
import {
  classifyGcloudConfig,
  parseAdcDocument,
  parseGcloudConfiguration,
  resolveActiveConfigName,
  resolveGcloudConfigPaths,
} from "./gcloud-config.ts"
import type { AdcInfo } from "../../services/GoogleClient.ts"

// ---------------------------------------------------------------------------
// resolveGcloudConfigPaths
// ---------------------------------------------------------------------------

describe("resolveGcloudConfigPaths", () => {
  it("defaults to ~/.config/gcloud on POSIX", () => {
    const paths = resolveGcloudConfigPaths({}, "/home/dev", "linux")

    expect(paths).toEqual({
      root: "/home/dev/.config/gcloud",
      activeConfigFile: "/home/dev/.config/gcloud/active_config",
      configurationsDir: "/home/dev/.config/gcloud/configurations",
      adcFile: "/home/dev/.config/gcloud/application_default_credentials.json",
    })
  })

  it("uses %APPDATA%\\gcloud on Windows — never %LOCALAPPDATA%", () => {
    const paths = resolveGcloudConfigPaths(
      { APPDATA: "C:\\Users\\dev\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
      "C:\\Users\\dev",
      "win32",
    )

    expect(paths.root).toBe("C:\\Users\\dev\\AppData\\Roaming\\gcloud")
    expect(paths.configurationsDir).toBe("C:\\Users\\dev\\AppData\\Roaming\\gcloud\\configurations")
    expect(paths.adcFile).toBe(
      "C:\\Users\\dev\\AppData\\Roaming\\gcloud\\application_default_credentials.json",
    )
    expect(paths.root).not.toContain("Local\\gcloud")
  })

  it("falls back to the home-relative Roaming path when APPDATA is unset", () => {
    const paths = resolveGcloudConfigPaths({}, "C:\\Users\\dev", "win32")

    expect(paths.root).toBe("C:\\Users\\dev\\AppData\\Roaming\\gcloud")
  })

  it("lets a set CLOUDSDK_CONFIG win over the platform default", () => {
    const paths = resolveGcloudConfigPaths(
      { CLOUDSDK_CONFIG: "/opt/gcloud-config" },
      "/home/dev",
      "linux",
    )

    expect(paths.root).toBe("/opt/gcloud-config")
    expect(paths.activeConfigFile).toBe("/opt/gcloud-config/active_config")
  })

  it("does not double the separator when CLOUDSDK_CONFIG has a trailing slash", () => {
    const paths = resolveGcloudConfigPaths(
      { CLOUDSDK_CONFIG: "/opt/gcloud-config/" },
      "/home/dev",
      "linux",
    )

    expect(paths.configurationsDir).toBe("/opt/gcloud-config/configurations")
  })

  it("treats a set-but-empty CLOUDSDK_CONFIG as 'no gcloud config', never a fallthrough", () => {
    const paths = resolveGcloudConfigPaths({ CLOUDSDK_CONFIG: "" }, "/home/dev", "linux")

    expect(paths).toEqual({
      root: "",
      activeConfigFile: "",
      configurationsDir: "",
      adcFile: "",
    })
    // The home default must not leak back in.
    expect(paths.configurationsDir).not.toContain(".config")
  })

  it("never returns a working-directory-relative path when the home dir is unknown", () => {
    const paths = resolveGcloudConfigPaths({}, "", "linux")

    expect(paths.configurationsDir).toBe("")
  })
})

// ---------------------------------------------------------------------------
// parseGcloudConfiguration
// ---------------------------------------------------------------------------

describe("parseGcloudConfiguration", () => {
  it("reads core.account/core.project and compute.region/compute.zone", () => {
    const fields = parseGcloudConfiguration(
      [
        "[core]",
        "account = dev@example.com",
        "project = my-project",
        "",
        "[compute]",
        "region = us-central1",
        "zone = us-central1-a",
      ].join("\n"),
    )

    expect(fields).toEqual({
      account: "dev@example.com",
      project: "my-project",
      region: "us-central1",
      zone: "us-central1-a",
    })
  })

  it("omits fields whose section is missing", () => {
    const fields = parseGcloudConfiguration("[core]\nproject = my-project\n")

    expect(fields).toEqual({ project: "my-project" })
    expect("region" in fields).toBe(false)
    expect("zone" in fields).toBe(false)
  })

  it("omits blank values rather than reporting an empty string", () => {
    const fields = parseGcloudConfiguration("[core]\naccount =\nproject = my-project\n")

    expect("account" in fields).toBe(false)
    expect(fields.project).toBe("my-project")
  })

  it("ignores keys outside the sections it reads", () => {
    const fields = parseGcloudConfiguration(
      "[core]\nproject = my-project\n\n[billing]\nquota_project = other-project\n",
    )

    expect(fields).toEqual({ project: "my-project" })
  })

  it("returns nothing for an empty or section-less file", () => {
    expect(parseGcloudConfiguration("")).toEqual({})
    expect(parseGcloudConfiguration("project = loose-key\n")).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// classifyGcloudConfig
// ---------------------------------------------------------------------------

describe("classifyGcloudConfig", () => {
  const adc = (type: AdcInfo["type"]): AdcInfo => ({ path: "/home/dev/adc.json", type })

  it("classifies a user ADC as adc-user", () => {
    expect(classifyGcloudConfig({ project: "p" }, adc("authorized_user"))).toBe("adc-user")
  })

  it("classifies a service-account ADC as adc-service-account", () => {
    expect(classifyGcloudConfig({ project: "p" }, adc("service_account"))).toBe(
      "adc-service-account",
    )
  })

  it("classifies external and impersonated ADC as adc-external", () => {
    expect(classifyGcloudConfig({}, adc("external_account"))).toBe("adc-external")
    expect(classifyGcloudConfig({}, adc("impersonated_service_account"))).toBe("adc-external")
  })

  it("classifies a configuration with a project but no ADC as config-only", () => {
    expect(classifyGcloudConfig({ project: "my-project" })).toBe("config-only")
  })

  it("classifies a configuration with neither ADC nor project as unsupported", () => {
    expect(classifyGcloudConfig({ account: "dev@example.com" })).toBe("unsupported")
    expect(classifyGcloudConfig({})).toBe("unsupported")
  })

  it("classifies an ADC type that has no file form as unsupported", () => {
    expect(classifyGcloudConfig({ project: "p" }, adc("access_token"))).toBe("unsupported")
    expect(classifyGcloudConfig({ project: "p" }, adc("gce_metadata"))).toBe("unsupported")
  })
})

// ---------------------------------------------------------------------------
// parseAdcDocument
// ---------------------------------------------------------------------------

describe("parseAdcDocument", () => {
  const ADC_PATH = "/home/dev/.config/gcloud/application_default_credentials.json"

  it("returns metadata ONLY — never the secret fields", () => {
    const info = parseAdcDocument(
      ADC_PATH,
      JSON.stringify({
        type: "authorized_user",
        client_id: "client-id.apps.googleusercontent.com",
        client_secret: "SUPER_SECRET",
        refresh_token: "1//super-secret-refresh",
        quota_project_id: "my-project",
      }),
    )

    expect(info).toEqual({
      path: ADC_PATH,
      type: "authorized_user",
      quotaProjectId: "my-project",
    })

    const serialized = JSON.stringify(info)
    expect(serialized).not.toContain("SUPER_SECRET")
    expect(serialized).not.toContain("super-secret-refresh")
    expect(serialized).not.toContain("client_secret")
    expect(serialized).not.toContain("refresh_token")
  })

  it("surfaces client_email for a service-account document without its private key", () => {
    const info = parseAdcDocument(
      "/home/dev/key.json",
      JSON.stringify({
        type: "service_account",
        client_email: "runbooks@my-project.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----SECRET-----END PRIVATE KEY-----",
        project_id: "my-project",
      }),
    )

    expect(info).toEqual({
      path: "/home/dev/key.json",
      type: "service_account",
      clientEmail: "runbooks@my-project.iam.gserviceaccount.com",
    })
    expect(JSON.stringify(info)).not.toContain("PRIVATE KEY")
  })

  it("maps external_account_authorized_user onto external_account", () => {
    const info = parseAdcDocument(
      ADC_PATH,
      JSON.stringify({ type: "external_account_authorized_user" }),
    )

    expect(info.type).toBe("external_account")
  })

  it("throws a content-free message for a document that is not valid JSON", () => {
    const notJson = '{"type":"authorized_user","refresh_token":"1//super-secret-refresh"'

    expect(() => parseAdcDocument(ADC_PATH, notJson)).toThrow(`${ADC_PATH} is not valid JSON`)
    try {
      parseAdcDocument(ADC_PATH, notJson)
    } catch (err) {
      expect((err as Error).message).not.toContain("super-secret-refresh")
    }
  })

  it("throws for a JSON value that is not an object", () => {
    expect(() => parseAdcDocument(ADC_PATH, '["a"]')).toThrow("is not a JSON object")
    expect(() => parseAdcDocument(ADC_PATH, "null")).toThrow("is not a JSON object")
  })

  it("throws for a missing or unsupported credential type", () => {
    expect(() => parseAdcDocument(ADC_PATH, "{}")).toThrow(
      "Unsupported Google credentials type: (missing)",
    )
    expect(() => parseAdcDocument(ADC_PATH, '{"type":"magic"}')).toThrow(
      "Unsupported Google credentials type: magic",
    )
  })
})

// ---------------------------------------------------------------------------
// resolveActiveConfigName
// ---------------------------------------------------------------------------

describe("resolveActiveConfigName", () => {
  it("prefers CLOUDSDK_ACTIVE_CONFIG_NAME over the file", () => {
    expect(resolveActiveConfigName({ CLOUDSDK_ACTIVE_CONFIG_NAME: "staging" }, "prod")).toBe(
      "staging",
    )
  })

  it("trims the file contents", () => {
    expect(resolveActiveConfigName({}, "prod\n")).toBe("prod")
  })

  it("falls back to 'default' when the file is missing, empty, or blank", () => {
    expect(resolveActiveConfigName({}, undefined)).toBe("default")
    expect(resolveActiveConfigName({}, "")).toBe("default")
    expect(resolveActiveConfigName({}, "  \n")).toBe("default")
  })

  it("ignores a blank CLOUDSDK_ACTIVE_CONFIG_NAME and uses the file", () => {
    expect(resolveActiveConfigName({ CLOUDSDK_ACTIVE_CONFIG_NAME: "  " }, "prod")).toBe("prod")
  })
})
