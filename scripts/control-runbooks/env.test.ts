import { describe, it, expect } from "bun:test"
import { withoutCredentials } from "./env.ts"

describe("withoutCredentials", () => {
  it("drops cloud and Git host credentials and keeps the rest", () => {
    expect(
      withoutCredentials({
        PATH: "/usr/bin",
        AWS_ACCESS_KEY_ID: "AKIA",
        AWS_PROFILE: "prod",
        GOOGLE_APPLICATION_CREDENTIALS: "/key.json",
        CLOUDSDK_AUTH_ACCESS_TOKEN: "ya29",
        GH_TOKEN: "ghp",
        GITHUB_TOKEN: "ghp",
        GITLAB_TOKEN: "glpat",
        DISPLAY: ":0",
      }),
    ).toEqual({ PATH: "/usr/bin", DISPLAY: ":0" })
  })
})
