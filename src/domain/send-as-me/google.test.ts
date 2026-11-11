import { describe, it, expect } from "bun:test"
import { googleSendable } from "./google.ts"
import type { HttpRequest } from "../../services/HttpRequest.ts"

const get = (url: string, extra: Partial<HttpRequest> = {}): HttpRequest => ({
  method: "GET",
  url,
  headers: {},
  ...extra,
})

const refusal = (request: HttpRequest): string => {
  const result = googleSendable(request)
  if (!("refused" in result)) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`)
  return result.refused
}

describe("googleSendable", () => {
  it("sends a GET to a Google API host", () => {
    const request = get(
      "https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer",
      {
        headers: { Accept: "application/json" },
      },
    )
    expect(googleSendable(request)).toEqual({ ...request, headers: { accept: "application/json" } })
  })

  it("refuses anything but GET", () => {
    expect(
      refusal({
        method: "POST",
        url: "https://admin.googleapis.com/admin/directory/v1/groups",
        headers: {},
        body: "{}",
      }),
    ).toContain("only GET")
  })

  it("sends to any Google API host", () => {
    const request = get("https://secretmanager.googleapis.com/v1/projects/p/secrets")
    expect(googleSendable(request)).toEqual(request)
  })

  it("refuses hosts that aren't Google API hosts", () => {
    for (const url of [
      "https://admin.googleapis.com.attacker.example/",
      "https://a.b.googleapis.com/",
      "https://googleapis.com/",
      "https://example.com/",
    ]) {
      expect(refusal(get(url))).toContain("only to Google API hosts")
    }
  })

  it("refuses URLs that could reach another server or hide the host", () => {
    expect(refusal(get("http://admin.googleapis.com/"))).toContain("https")
    expect(refusal(get("https://user@admin.googleapis.com/"))).toContain("names a user")
    expect(refusal(get("https://admin.googleapis.com:8443/"))).toContain("port")
  })

  it("refuses headers other than Accept", () => {
    expect(
      refusal(
        get("https://admin.googleapis.com/", { headers: { "X-Goog-User-Project": "other" } }),
      ),
    ).toContain("can't set the X-Goog-User-Project header")
  })
})
