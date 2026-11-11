import { describe, it, expect } from "bun:test"
import { awsSendable } from "./aws.ts"
import type { HttpRequest } from "../../services/HttpRequest.ts"

const json = (host: string, target: string, extra: Partial<HttpRequest> = {}): HttpRequest => ({
  method: "POST",
  url: `https://${host}/`,
  headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": target },
  body: "{}",
  ...extra,
})

const query = (url: string): HttpRequest => ({ method: "GET", url, headers: {} })

const refusal = (request: HttpRequest): string => {
  const result = awsSendable(request)
  if (!("refused" in result)) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`)
  return result.refused
}

describe("awsSendable", () => {
  it("signs a JSON-protocol read for the service and region its host names", () => {
    const result = awsSendable(
      json("sso.us-east-2.amazonaws.com", "SWBExternalService.ListInstances"),
    )
    expect(result).toMatchObject({
      signing: { service: "sso", region: "us-east-2" },
      action: "ListInstances",
      request: { headers: { "x-amz-target": "SWBExternalService.ListInstances" } },
    })
  })

  it("signs a global endpoint for its home region", () => {
    expect(
      awsSendable(query("https://iam.amazonaws.com/?Action=ListRoles&Version=2010-05-08")),
    ).toMatchObject({ signing: { service: "iam", region: "us-east-1" }, action: "ListRoles" })
  })

  it("reads a Query-protocol Action from a form body", () => {
    const result = awsSendable({
      method: "POST",
      url: "https://sts.us-west-2.amazonaws.com/",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "Action=GetCallerIdentity&Version=2011-06-15",
    })
    expect(result).toMatchObject({ signing: { service: "sts", region: "us-west-2" } })
  })

  it("refuses writes", () => {
    expect(
      refusal(
        json("organizations.us-east-1.amazonaws.com", "AWSOrganizationsV20161128.CreateAccount"),
      ),
    ).toContain("CreateAccount")
    expect(refusal(query("https://ec2.us-east-1.amazonaws.com/?Action=RunInstances"))).toContain(
      "only reads",
    )
  })

  it("refuses reads that return a secret", () => {
    expect(refusal(query("https://sts.amazonaws.com/?Action=GetSessionToken"))).toContain(
      "returns a secret",
    )
    expect(
      refusal(query("https://ec2.eu-west-1.amazonaws.com/?Action=GetPasswordData&InstanceId=i-1")),
    ).toContain("returns a secret")
  })

  it("refuses hosts that aren't listed endpoints, including S3 and API Gateway", () => {
    for (const host of [
      "s3.us-east-1.amazonaws.com",
      "my-bucket.s3.us-east-1.amazonaws.com",
      "s3-us-west-2.amazonaws.com",
      "abc123.execute-api.us-east-1.amazonaws.com",
      "sso.us-east-1.amazonaws.com.attacker.example",
      "lambda.us-east-1.amazonaws.com",
      "example.com",
    ]) {
      expect(refusal(query(`https://${host}/?Action=ListThings`))).toContain(
        "doesn't send requests to",
      )
    }
  })

  it("refuses a request whose operation it can't tell", () => {
    expect(refusal(json("identitystore.us-east-2.amazonaws.com", ""))).toContain("X-Amz-Target")
    expect(refusal(query("https://iam.amazonaws.com/"))).toContain("exactly one Action")
    expect(
      refusal(query("https://iam.amazonaws.com/?Action=ListRoles&Action=CreateRole")),
    ).toContain("exactly one Action")
    expect(
      refusal({
        method: "POST",
        url: "https://iam.amazonaws.com/?Action=ListRoles",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "Action=DeleteRole",
      }),
    ).toContain("exactly one Action")
  })

  it("refuses a JSON-protocol request with a path or query, which would hide another operation", () => {
    expect(
      refusal(
        json("sso.us-east-2.amazonaws.com", "SWBExternalService.ListInstances", {
          url: "https://sso.us-east-2.amazonaws.com/?Action=Delete",
        }),
      ),
    ).toContain("root path")
  })

  it("refuses headers the block sets itself", () => {
    expect(
      refusal({
        ...query("https://iam.amazonaws.com/?Action=ListRoles"),
        headers: { Authorization: "AWS4-HMAC-SHA256 ..." },
      }),
    ).toContain("can't set the Authorization header")
  })
})
