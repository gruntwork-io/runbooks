import { describe, it, expect } from "vitest"
import { ssoPortals } from "../utils"

describe("ssoPortals", () => {
  it("lists each portal of the SSO profiles once, in order, skipping incomplete ones", () => {
    expect(
      ssoPortals([
        { name: "keys", authType: "static" },
        {
          name: "a",
          authType: "sso",
          ssoStartUrl: "https://a.awsapps.com/start",
          ssoRegion: "us-east-2",
        },
        { name: "no-region", authType: "sso", ssoStartUrl: "https://b.awsapps.com/start" },
        {
          name: "a-again",
          authType: "sso",
          ssoStartUrl: "https://a.awsapps.com/start",
          ssoRegion: "us-east-2",
        },
        {
          name: "c",
          authType: "sso",
          ssoStartUrl: "https://c.awsapps.com/start",
          ssoRegion: "eu-west-1",
        },
      ]),
    ).toEqual([
      { startUrl: "https://a.awsapps.com/start", region: "us-east-2" },
      { startUrl: "https://c.awsapps.com/start", region: "eu-west-1" },
    ])
  })
})
