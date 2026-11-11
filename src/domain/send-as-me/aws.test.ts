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
      request: { headers: { "x-amz-target": "SWBExternalService.ListInstances" } },
    })
  })

  it("signs any service's endpoint, not only ones a runbook used before", () => {
    expect(
      awsSendable(json("ssm.eu-west-1.amazonaws.com", "AmazonSSM.DescribeParameters")),
    ).toMatchObject({ signing: { service: "ssm", region: "eu-west-1" } })
  })

  it("signs a global endpoint for us-east-1", () => {
    expect(
      awsSendable(query("https://iam.amazonaws.com/?Action=ListRoles&Version=2010-05-08")),
    ).toMatchObject({ signing: { service: "iam", region: "us-east-1" } })
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

  it("sends a GET to a REST API, which names no operation", () => {
    expect(
      awsSendable(query("https://lambda.us-east-1.amazonaws.com/2015-03-31/functions")),
    ).toMatchObject({ signing: { service: "lambda", region: "us-east-1" } })
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
    expect(
      refusal({
        method: "POST",
        url: "https://lambda.us-east-1.amazonaws.com/2015-03-31/functions",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ).toContain("must be a GET")
  })

  it("refuses hosts that aren't AWS API endpoints, such as a bucket or API Gateway", () => {
    for (const host of [
      "my-bucket.s3.us-east-1.amazonaws.com",
      "abc123.execute-api.us-east-1.amazonaws.com",
      "sso.us-east-1.amazonaws.com.attacker.example",
      "amazonaws.com",
      "example.com",
    ]) {
      expect(refusal(query(`https://${host}/?Action=ListThings`))).toContain(
        "only to AWS API endpoints",
      )
    }
  })

  it("refuses a request whose operation it can't tell", () => {
    expect(refusal(json("identitystore.us-east-2.amazonaws.com", ""))).toContain("X-Amz-Target")
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
    expect(
      refusal(
        json("sso.us-east-2.amazonaws.com", "SWBExternalService.ListInstances", {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Amz-Target": "SWBExternalService.ListInstances",
          },
          body: "Action=DeleteInstance",
        }),
      ),
    ).toContain("not both")
  })

  it("refuses a JSON-protocol request with a path or query, which would hide another operation", () => {
    expect(
      refusal(
        json("sso.us-east-2.amazonaws.com", "SWBExternalService.ListInstances", {
          url: "https://sso.us-east-2.amazonaws.com/?Action=Delete",
        }),
      ),
    ).toMatch(/not both|root path/)
    expect(
      refusal(
        json("sso.us-east-2.amazonaws.com", "SWBExternalService.ListInstances", {
          url: "https://sso.us-east-2.amazonaws.com/instances",
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
